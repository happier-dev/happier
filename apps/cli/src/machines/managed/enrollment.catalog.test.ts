import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { machineSetup } from '@happier-dev/cli-common';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema, type ManagedMachineEnrollmentIdentityV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedEnrollmentCorrelationV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedBootstrapCarrierV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { readBundledPluginManifest } from '@/plugins/projection/registry/builtIn/manifestFile';
import { MachineEffectInternalRequestSchema } from '@/machines/setup/effectInternalProtocol';
// Collect the real, broad SSH task graph before the per-case execution budget.
import '@/capabilities/systemTasks/ssh/liveRemoteSshBootstrap';
import { configuration } from '@/configuration';
import { PLUGIN_MANIFEST as devcontainerManifest } from '../../../../../packages/plugins/devcontainer/src/manifest';
import { runManagedMachineEnrollment, type ManagedNativeBootstrapIO } from './enrollment';
import { resolveManagedEnrollmentSshTrust } from './enrollmentSshTrust';

type SshBoundary = typeof import('@happier-dev/cli-common/ssh');
type Command = Pick<Parameters<ManagedNativeBootstrapIO['exec']>[0], 'command' | 'input'>;
type CommandResult = Awaited<ReturnType<ManagedNativeBootstrapIO['exec']>>;
const sshBoundary = vi.hoisted(() => ({ run: null as null | ((request: Command) => Promise<CommandResult>) }));
const hostKey = 'catalog.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// Only the OS/SSH/file-transfer boundary is substituted. Normalized declarations,
// installation, held enrollment, task recipe and setup interpreter remain real.
vi.mock('@happier-dev/cli-common/ssh', async importOriginal => ({
  ...await importOriginal<SshBoundary>(),
  runOpenSshRemoteCommand: async (request: Parameters<SshBoundary['runOpenSshRemoteCommand']>[0]) => {
    if (!sshBoundary.run) throw new Error('Missing catalog SSH boundary');
    const shell = request.remoteCommand.at(-1) ?? '';
    const command = request.remoteCommand[0] === 'bash' && request.remoteCommand[1] === '-lc'
      ? shell.slice(1, -1).replaceAll("'\"'\"'", "'") : request.remoteCommand.join(' ');
    return sshBoundary.run({ command, input: request.input });
  },
  transferOpenSshFile: async () => {},
}));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: (...args: Parameters<typeof actual.spawnSync>) => args[0] === 'ssh-keyscan'
    ? { status: 0, stdout: hostKey + '\n', stderr: '' } : actual.spawnSync(...args) };
});

const dedicated = { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
  role: 'server', adminAccessAtCreation: 'preauthorized' } as const;
const personal = { kind: 'existingUser', role: 'personal' } as const;
const sandbox = { kind: 'guestProcess', role: 'sandbox' } as const;
type Fixture = Readonly<{
  key: `${string}/${string}`;
  declaredRole: 'server' | 'personal' | 'sandbox';
  identity: ManagedMachineEnrollmentIdentityV1;
  carrier: 'ssh' | 'native';
  guestHome?: true;
  platform?: 'Darwin';
  expectedGap?: 'dedicated_identity_unsupported';
}>;

// These are plan oracles for admitted roles and the real carrier shapes censused
// from the provider producers. They do not reproduce production default selection.
const fixtures: readonly Fixture[] = [
  { key: 'happier.machine.agent37/agent37', declaredRole: 'sandbox', identity: sandbox, carrier: 'native' },
  { key: 'happier.machine.boat/boat', declaredRole: 'server', identity: dedicated, carrier: 'ssh' },
  { key: 'happier.machine.coder/coder', declaredRole: 'server', identity: dedicated, carrier: 'native' },
  { key: 'happier.machine.crabbox/crabbox-coordinator', declaredRole: 'server', identity: dedicated, carrier: 'ssh' },
  { key: 'happier.machine.crabbox/crabbox', declaredRole: 'sandbox', identity: sandbox, carrier: 'ssh' },
  { key: 'happier.machine.digitalocean/digitalocean', declaredRole: 'server', identity: dedicated, carrier: 'ssh' },
  { key: 'happier.machine.hetzner/hetzner', declaredRole: 'server', identity: dedicated, carrier: 'ssh' },
  { key: 'happier.machine.lume/lume', declaredRole: 'personal', identity: personal, carrier: 'ssh', platform: 'Darwin' },
  { key: 'happier.machine.lima/lima', declaredRole: 'server', identity: dedicated, carrier: 'native' },
  { key: 'happier.machine.lima/lima', declaredRole: 'server', identity: dedicated, carrier: 'native', platform: 'Darwin', expectedGap: 'dedicated_identity_unsupported' },
  { key: 'happier.machine.cua/local-sandbox', declaredRole: 'sandbox', identity: sandbox, carrier: 'native' },
  { key: 'happier.machine.cua/local-sandbox', declaredRole: 'sandbox', identity: sandbox, carrier: 'native', guestHome: true },
  { key: 'happier.machine.cua/local-space', declaredRole: 'sandbox', identity: sandbox, carrier: 'native' },
  { key: 'happier.machine.cua/byoc', declaredRole: 'sandbox', identity: sandbox, carrier: 'native' },
  { key: 'happier.machine.daytona/daytona', declaredRole: 'sandbox', identity: sandbox, carrier: 'native' },
  { key: 'happier.machine.docker-sandboxes/docker-sandboxes', declaredRole: 'sandbox', identity: sandbox, carrier: 'native' },
  { key: 'happier.machine.e2b/e2b', declaredRole: 'sandbox', identity: sandbox, carrier: 'native' },
  { key: 'happier.machine.fly/fly', declaredRole: 'sandbox', identity: sandbox, carrier: 'native', guestHome: true },
  { key: 'happier.machine.freestyle/freestyle', declaredRole: 'sandbox', identity: sandbox, carrier: 'native' },
  { key: 'happier.machine.maritime/maritime', declaredRole: 'server', identity: dedicated, carrier: 'native' },
  { key: 'happier.machine.modal/modal', declaredRole: 'sandbox', identity: sandbox, carrier: 'native' },
  { key: 'happier.machine.railway/railway', declaredRole: 'sandbox', identity: sandbox, carrier: 'native' },
  { key: 'happier.machine.superserve/superserve', declaredRole: 'sandbox', identity: sandbox, carrier: 'native' },
  { key: 'happier.machine.upstash-box/upstash-box', declaredRole: 'sandbox', identity: sandbox, carrier: 'native' },
  { key: 'happier.machine.vercel/vercel', declaredRole: 'sandbox', identity: sandbox, carrier: 'native', guestHome: true },
  { key: 'happier.devcontainer/devcontainer', declaredRole: 'sandbox', identity: sandbox, carrier: 'native' },
];

function provisioners() {
  const manifests = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.map(locator => normalizePluginManifestV2(readBundledPluginManifest(locator)));
  // Devcontainer is a current Plan-10 child contract, but remains reservation_only
  // rather than bundled. Normalize its actual author declaration independently.
  if (!manifests.some(manifest => manifest.id === devcontainerManifest.id)) manifests.push(normalizePluginManifestV2(devcontainerManifest));
  return new Map(manifests.flatMap(manifest => manifest.contributes.machineProvisioners.map(definition =>
    [`${manifest.id}/${definition.id}`, definition] as const)));
}

afterEach(() => { sshBoundary.run = null; vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('normalized Machine catalog at the shared enrollment boundary', () => {
  it('requires an enrollment fixture for every current normalized provisioner, without a provider-count ceiling', () => {
    const declared = [...provisioners().keys()].sort();
    const covered = [...new Set(fixtures.map(fixture => fixture.key))].sort();
    expect(covered).toEqual(declared);
  });

  it.each(fixtures)('$key honors $identity.kind through $carrier (persistent home: $guestHome, platform: $platform)', async fixture => {
    const definition = provisioners().get(fixture.key);
    expect(definition, `Missing normalized provisioner ${fixture.key}`).toBeDefined();
    if (!definition) throw new Error(`Missing normalized provisioner ${fixture.key}`);
    expect(definition.enrollmentRole).toBe(fixture.declaredRole);
    expect(definition.bootstrapTransport?.kind ?? 'ssh').toBe(fixture.carrier);
    expect(definition.enrollmentRole).toBe(fixture.identity.role);
    const split = fixture.key.lastIndexOf('/');
    const contributionRef = { pluginId: fixture.key.slice(0, split), localId: fixture.key.slice(split + 1) };
    const root = await mkdtemp(join(tmpdir(), 'happier-catalog-enrollment-'));
    const commands: Command[] = [];
    const plans: machineSetup.MachineSetupEffectPlanV1[] = [];
    const applied = new Set<string>();
    const observe: machineSetup.MachineSetupBackend['observe'] = async step => ({
      stepId: step.id, status: applied.has(step.id) ? 'satisfied' : 'drifted', facts: {},
    });
    const backend: machineSetup.MachineSetupBackend = { observe, apply: async step => { applied.add(step.id); } };
    const resource = { contributionRef, schemaVersion: definition.schemaVersion, value: { fixture: fixture.key } };
    const correlation = ManagedEnrollmentCorrelationV1Schema.parse({ homeId: 'srv_catalog_home', managedId: fixture.key,
      requestId: 'catalog-enrollment', expectedIntentRevision: 1,
      controller: { machineId: 'controller', installationId: 'installation' }, resource });
    const credentialRef = { kind: 'shared_resource', resourceId: 'catalog-ssh-key' } as const;
    const machine = ManagedMachineV1Schema.parse({ id: correlation.managedId, homeId: correlation.homeId,
      custodianAccountId: 'owner', controller: correlation.controller, enrollmentIdentity: fixture.identity,
      launch: { provider: contributionRef, schemaVersion: definition.schemaVersion, name: 'Catalog guest', choices: {} },
      resource, ...(fixture.carrier === 'ssh' ? { bootstrapCredentialRef: credentialRef } : {}),
      allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const target = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: correlation.homeId,
      canonicalServerUrl: 'https://catalog-home.example.test', revision: 1,
      endpoints: [{ kind: 'https', url: 'https://catalog-home.example.test' }] }, authority: 'trusted_enrollment' });
    try {
      const payload = join(root, 'payload');
      await mkdir(payload);
      await writeFile(join(payload, 'happier'), '#!/bin/sh\nexit 0\n');
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', payload);
      const run = async (request: Command): Promise<CommandResult> => {
        commands.push(request);
        const ok = (stdout = '{}\n') => ({ status: 0, stdout, stderr: '' });
        if (request.command.includes('effect-internal')) {
          const frame = MachineEffectInternalRequestSchema.parse(JSON.parse(String(request.input ?? '').split('\n')[0]!));
          if (frame.mode === 'check' && (!('basis' in frame) || !('steps' in frame))) throw new Error('Expected a bootstrap check');
          if (frame.mode === 'apply' && !('plans' in frame)) throw new Error('Expected bootstrap plans');
          const result = frame.mode === 'check'
            ? { status: 'checked' as const, plan: await machineSetup.checkMachineSetupEffectPlan({ basis: frame.basis, steps: frame.steps, backend }) }
            : await machineSetup.applyMachineSetupEffectPlans({ ...frame, daemonUsername: 'daemonUsername' in frame ? frame.daemonUsername ?? undefined : undefined, backend });
          if (result.status === 'checked') plans.push(result.plan);
          return ok(JSON.stringify({ type: 'result', result }) + '\n');
        }
        if (request.command.includes('/etc/os-release')) return ok('ubuntu\nnoble\namd64\n');
        if (request.command === 'id -u happier') return ok('1001\n');
        if (request.command.includes('"arch"')) return ok(JSON.stringify({ platform: fixture.platform === 'Darwin' ? 'darwin' : 'linux', arch: 'x86_64' }));
        if (request.command.includes('uname -m')) return ok(`${fixture.platform ?? 'Linux'}\nx86_64\n/home/bootstrap\n`);
        if (request.command === 'uname -s') return ok(`${fixture.platform ?? 'Linux'}\n`);
        if (request.command.includes('mktemp -d /tmp/happier-bootstrap-upload.')) return ok('/tmp/happier-bootstrap-upload.catalog\n');
        if (request.command.includes('mktemp')) return ok('/tmp/happier-bootstrap-transfer.catalog\n');
        if (request.command.includes('current_target##*/')) return ok('current=test\nprevious=\nversion=test\n');
        if (request.command.includes("'service' 'list'")) return ok(JSON.stringify({ services: [], platform: fixture.platform === 'Darwin' ? 'darwin' : 'linux' }));
        // The guest executable is an OS boundary. Invalid pairing output stops
        // after identity/installer/service preflight, before any Account access.
        if (request.command.includes("'auth'")) return ok('{}\n');
        return ok();
      };
      sshBoundary.run = run;
      const carrier = ManagedBootstrapCarrierV1Schema.parse(fixture.carrier === 'ssh' ? {
        kind: 'ssh', address: 'catalog.example.test', user: fixture.identity.kind === 'dedicatedDaemonUser' ? 'root' : 'personal',
        credentialRef, hostKeyEvidence: { hostKey, fingerprint: `SHA256:${createHash('sha256')
          .update(Buffer.from(hostKey.split(' ')[2]!, 'base64')).digest('base64').replace(/=+$/u, '')}` },
      } : { kind: 'native', transport: { contributionRef, schemaVersion: definition.schemaVersion },
        ...(fixture.guestHome ? { guestHome: { homeDir: '/persistent/home', happyHomeDir: '/persistent/home/.happier', daemonStartup: 'native-process' } } : {}) });
      if (carrier.kind === 'ssh') {
        // Seed approval through the same resource-scoped path the live adapter uses.
        const { knownHostsPath } = await resolveManagedEnrollmentSshTrust({ correlation, carrier });
        await mkdir(dirname(knownHostsPath), { recursive: true });
        await writeFile(knownHostsPath, hostKey + '\n');
      }
      const enrollment = runManagedMachineEnrollment({ correlation, target, carrier, channel: 'stable',
        onPrompt: prompt => { if (prompt) throw new Error(`Unexpected catalog enrollment prompt: ${prompt.kind}`); },
      }, {
        readCurrentManagedRow: async () => machine,
        native: { exec: run, async putFile() {} },
        materializeBootstrapCredential: async () => ({ path: join(root, 'identity'), async dispose() {} }),
      });
      await expect(enrollment).rejects.toMatchObject({ code: fixture.expectedGap ?? 'invalid_cli_response' });
      if (fixture.expectedGap) {
        expect(commands.map(request => request.command)).toEqual(['uname -s']);
        expect(applied.size).toBe(0);
        return;
      }
      const auth = commands.findIndex(request => request.command.includes("'auth'"));
      expect(auth, 'The real enrollment recipe must reach the guest auth boundary').toBeGreaterThan(-1);
      const beforePairing = commands.slice(0, auth);
      const interpreter = beforePairing.findIndex(request => request.command.includes('effect-internal'));
      if (fixture.identity.kind === 'dedicatedDaemonUser') {
        expect(interpreter, 'Dedicated bootstrap cannot inherit the root login').toBeGreaterThan(-1);
        expect(applied.size).toBeGreaterThan(0);
        expect(plans).toHaveLength(1);
        expect(plans[0]?.steps).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'user', username: 'happier-agent' }),
          expect.objectContaining({ kind: 'file', path: '/etc/sudoers.d/90-happier-daemon' }),
        ]));
        expect(commands[auth]?.command).toContain('runuser -u happier');
        expect(commands[auth]?.command).toContain('/opt/happier/cli/current/happier');
      } else {
        expect(interpreter).toBe(-1);
        expect(commands[auth]?.command).not.toContain('runuser -u happier');
      }
      if (fixture.identity.kind === 'guestProcess') {
        expect(beforePairing.some(request => request.command.includes("'service'")), 'A sandbox cannot require a user-service manager').toBe(false);
      }
      if (fixture.guestHome) expect(commands[auth]?.command).toContain("HAPPIER_HOME_DIR='/persistent/home/.happier'");
    } finally { sshBoundary.run = null; await rm(root, { recursive: true, force: true }); }
  });
});
