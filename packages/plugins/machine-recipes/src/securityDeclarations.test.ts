import { expect, it } from 'vitest';
import { MachineRecipeV1Schema, resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { sshHardening } from './sshHardening.js';
import { sshFail2ban } from './sshFail2ban.js';
import { boundedJournal } from './boundedJournal.js';
import { auditLogging } from './auditLogging.js';
import { tailscaleServer } from './tailscaleServer.js';
import { evaluateInputPredicate } from '@happier-dev/protocol/inputs/inputPredicates';

it('requires the reviewed administrator and proves the effective key-only policy before reload', () => {
  const recipe = MachineRecipeV1Schema.parse({ id: 'ssh-hardening', ...sshHardening });
  const schema = compilePluginJsonSchema(recipe.inputSchema);
  const inputs = { administrator: { username: 'operator', host: 'probe', address: '192.0.2.1' }, sshServiceUnit: 'ssh.service', currentPort: 2222 };
  expect(isValidPluginJsonSchemaValue(schema, inputs)).toBe(true);
  for (const invalid of [{}, { ...inputs, administrator: { ...inputs.administrator, username: 'root' } },
    { ...inputs, administrator: { ...inputs.administrator, address: '192.0.2.1\nPasswordAuthentication yes' } }]) {
    expect(isValidPluginJsonSchemaValue(schema, invalid)).toBe(false);
  }
  const file = resolveMachineRecipeStepInputsV1(recipe.steps[0]!, inputs);
  expect(file).toMatchObject({ kind: 'file', path: '/etc/ssh/sshd_config.d/00-happier-hardening.conf',
    content: { kind: 'literal', value: expect.stringContaining('PasswordAuthentication no\n') },
    validate: { kind: 'sshd' }, probe: { kind: 'sshd', contexts: expect.arrayContaining([expect.objectContaining({ user: 'operator',
      expected: expect.objectContaining({ passwordauthentication: 'no', permitrootlogin: 'no', allowtcpforwarding: 'no', port: '2222' }) }),
      expect.objectContaining({ user: 'root', expected: expect.objectContaining({ permitrootlogin: 'no' }) })]) },
    onChange: { serviceStepId: 'ssh-service', action: 'reload' } });
  expect(file.kind === 'file' && file.content?.kind === 'literal' && file.content.value).not.toContain('UsePAM');
  const removal = recipe.removeSteps?.map(step => resolveMachineRecipeStepInputsV1(step, inputs));
  expect(removal?.[0]).toMatchObject({ kind: 'file', state: 'absent', expectedContentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    validate: { kind: 'sshd' }, onChange: { action: 'reload' } });
});

it('requires explicit journal capacity and removes only its exact rendered policy', () => {
  const recipe = MachineRecipeV1Schema.parse({ id: 'bounded-journal', ...boundedJournal });
  const schema = compilePluginJsonSchema(recipe.inputSchema);
  for (const maximumUse of ['128M', '2G', '512000']) {
    const inputs = { maximumUse };
    expect(isValidPluginJsonSchemaValue(schema, inputs)).toBe(true);
    expect(resolveMachineRecipeStepInputsV1(recipe.steps.find(step => step.kind === 'file')!, inputs)).toMatchObject({ kind: 'file',
      content: { kind: 'literal', value: `[Journal]\nStorage=persistent\nSystemMaxUse=${maximumUse}\n` },
      onChange: { serviceStepId: 'journal-service', action: 'restart' } });
    expect(resolveMachineRecipeStepInputsV1(recipe.removeSteps![0]!, inputs)).toMatchObject({ kind: 'file', state: 'absent',
      expectedContentDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  }
  for (const inputs of [{}, { maximumUse: '0' }, { maximumUse: '2G\nForwardToSyslog=yes' }]) {
    expect(isValidPluginJsonSchemaValue(schema, inputs)).toBe(false);
  }
});

it('makes SSH bans posture-dependent with reviewed retry windows and preserves foreign jails', () => {
  const recipe = MachineRecipeV1Schema.parse({ id: 'ssh-fail2ban', ...sshFail2ban });
  expect(recipe.appliesWhen).toEqual({ posture: 'publicSshOpen' });
  const schema = compilePluginJsonSchema(recipe.inputSchema);
  const inputs = { port: 2222, maxRetry: 5, findTime: 600, banTime: 3600,
    recidiveMaxRetry: 3, recidiveFindTime: 86400, recidiveBanTime: 604800 };
  expect(isValidPluginJsonSchemaValue(schema, inputs)).toBe(true);
  expect(isValidPluginJsonSchemaValue(schema, { ...inputs, maxRetry: undefined })).toBe(false);
  const file = recipe.steps.find(step => step.kind === 'file');
  if (!file) throw new Error('Missing owned jail policy');
  expect(resolveMachineRecipeStepInputsV1(file, inputs)).toMatchObject({ kind: 'file',
    path: '/etc/fail2ban/jail.d/happier-sshd.local', content: { value: expect.stringContaining('port=2222\n') },
    validate: { kind: 'fail2ban' }, probe: { kind: 'fail2ban', jails: {
      'happier-sshd': { maxRetry: 5, findTimeSeconds: 600, banTimeSeconds: 3600, port: 2222 },
      'happier-recidive': { maxRetry: 3, findTimeSeconds: 86400, banTimeSeconds: 604800 },
    } } });
  const rendered = resolveMachineRecipeStepInputsV1(file, inputs);
  expect(rendered.kind === 'file' && rendered.content?.kind === 'literal' && rendered.content.value)
    .toContain('[happier-recidive]\nenabled=true\nfilter=recidive[_jailname="happier-sshd"]\nbackend=%(recidive/backend)s\nlogpath=%(recidive/logpath)s\nbanaction=%(recidive/banaction)s\n');
  expect(recipe.removeSteps?.filter(step => step.kind === 'file').map(step => step.path)).toEqual(['/etc/fail2ban/jail.d/happier-sshd.local']);
});

it('declares host-security audit rules only after a native audit capability check', () => {
  const recipe = MachineRecipeV1Schema.parse({ id: 'audit-logging', ...auditLogging });
  expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(recipe.inputSchema), { profile: 'host-security' })).toBe(true);
  const check = recipe.steps.find(step => step.id === 'audit-kernel');
  expect(check).toMatchObject({ kind: 'command', executable: 'auditctl', args: ['-s'] });
  expect(recipe.steps.find(step => step.kind === 'file')).toMatchObject({ kind: 'file',
    path: '/etc/audit/rules.d/happier-host-security.rules' });
  expect(recipe.removeSteps?.filter(step => step.kind === 'file').map(step => step.path)).toEqual(['/etc/audit/rules.d/happier-host-security.rules']);
});

it('pins Tailscale vendor trust and binds the selected saved key to a reviewed network switch', () => {
  const recipe = MachineRecipeV1Schema.parse({ id: 'tailscale-server', ...tailscaleServer });
  const schema = compilePluginJsonSchema(recipe.inputSchema);
  // Lima's default Ubuntu template is 26.04 resolute; Tailscale serves it under the same signing key (checked 2026-11-22).
  for (const distribution of ['ubuntu-resolute', 'ubuntu-noble', 'ubuntu-jammy', 'debian-bookworm', 'debian-trixie']) {
    const inputs = { distribution, joinCredential: { ref: 'happier:shared-secret:v1:tailscale-key', resourceRevision: 7 },
      setOperator: true };
    expect(isValidPluginJsonSchemaValue(schema, inputs)).toBe(true);
    const credentialFile = '/run/happier-machine-credentials/installation.setup-key';
    const steps = recipe.steps.filter(step => step.when?.every(condition => 'input' in condition
      && evaluateInputPredicate(condition.input, inputs)) ?? true).filter(step => step.id !== 'tailscale-credential')
      .map(step => resolveMachineRecipeStepInputsV1(step, inputs,
        { 'daemon.username': 'happier-daemon', 'invocation.credentialFile': credentialFile }));
    expect(steps.filter(step => step.kind === 'packageSource')).toHaveLength(1);
    expect(steps.find(step => step.kind === 'packageSource')).toMatchObject({
      keyFingerprint: '2596A99EAAB33821893C0A79458CA832957F5868', manager: 'apt',
      path: '/etc/apt/sources.list.d/tailscale.list', keyPath: '/usr/share/keyrings/tailscale-archive-keyring.gpg',
    });
    expect(steps.filter(step => step.kind === 'command' && step.executable === 'grep')).toHaveLength(2);
    expect(steps.find(step => step.kind === 'serviceUnit')).toMatchObject({ unit: 'tailscaled.service', enabled: true, running: true });
    expect(steps.find(step => step.kind === 'directory')).toMatchObject({ path: '/run/happier-machine-credentials',
      owner: 'root', group: 'root', mode: 0o700 });
    expect(recipe.steps.find(step => step.id === 'tailscale-credential')).toMatchObject({ kind: 'file', lifetime: 'invocation', mode: 0o600,
      path: { kind: 'targetFact', fact: 'invocation.credentialFile' }, content: { kind: 'secretGrant', credentialSelection: {
        provider: { kind: 'builtin', id: 'tailscale' }, config: {}, credentialRefs: [{ purpose: 'network.join', credentialRef: {
          kind: 'savedSecret', ref: { kind: 'input', path: 'joinCredential.ref' }, resourceRevision: { kind: 'input', path: 'joinCredential.resourceRevision' },
        } }],
      } } });
    expect(steps.find(step => step.id === 'tailscale-join')).toMatchObject({ kind: 'command', executable: 'tailscale',
      args: ['up', '--force-reauth', `--auth-key=file:${credentialFile}`] });
    expect(steps.find(step => step.id === 'tailscale-switch')).toMatchObject({ kind: 'command', executable: 'tailscale', args: ['down'] });
    expect(isValidPluginJsonSchemaValue(schema, { ...inputs, switchNetwork: false })).toBe(false);
    expect(steps.filter(step => step.kind === 'command' && step.executable === 'tailscale').flatMap(step => step.args))
      .not.toEqual(expect.arrayContaining([expect.stringMatching(/^--advertise-(?:exit-node|routes)/)]));
  }
  expect(isValidPluginJsonSchemaValue(schema, { distribution: 'ubuntu-noble', authKey: 'must-never-be-a-recipe-input' })).toBe(false);
});
