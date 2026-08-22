import { spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  realpath,
} from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  evaluateVendorResumeEligibility,
} from '@happier-dev/agents';
import { buildPiRpcArgs } from '@happier-dev/plugins-pi/agent/runtime/rpc/args';
import {
  buildLinkedExternalSessionMetadataV1,
  buildLinkedExternalSessionQualifiedIdentityV1,
  PluginAgentExternalSessionLinkDataSchema,
  TranscriptRawRecordV1Schema,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import { resolveExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const PI_AGENT_ID = 'pi';
const PI_PLUGIN_ID = 'happier.agent.pi';
const liveSessionFile = process.env.HAPPIER_TEST_PI_REAL_SESSION_FILE?.trim() ?? '';
const livePiExecutable = process.env.HAPPIER_TEST_PI_EXECUTABLE?.trim() || 'pi';

type PiRpcState = Readonly<{
  sessionFile: string;
  sessionId: string;
  messageCount: number;
}>;

async function openCurrentPiSession(params: Readonly<{
  executable: string;
  args: readonly string[];
  agentDir: string;
  homeDir: string;
}>): Promise<PiRpcState> {
  const child = spawn(params.executable, params.args, {
    env: {
      HOME: params.homeDir,
      PATH: process.env.PATH ?? '',
      PI_CODING_AGENT_DIR: params.agentDir,
      XDG_CONFIG_HOME: join(params.homeDir, '.config'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  try {
    const state = await new Promise<PiRpcState>((resolve, reject) => {
      let stdout = Buffer.alloc(0);
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new Error('Current Pi native resume did not answer get_state within 30 seconds'));
      }, 30_000);
      timeout.unref();

      const finish = (result: PiRpcState | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };

      child.once('error', finish);
      child.once('exit', (code, signal) => {
        finish(new Error(
          `Current Pi native resume exited before get_state (${code ?? signal ?? 'unknown'}): `
          + Buffer.concat(stderr).toString('utf8').slice(0, 2_000),
        ));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = Buffer.concat([stdout, chunk]);
        for (
          let lineEnd = stdout.indexOf(0x0a);
          lineEnd >= 0;
          lineEnd = stdout.indexOf(0x0a)
        ) {
          const line = stdout.subarray(0, lineEnd).toString('utf8');
          stdout = stdout.subarray(lineEnd + 1);
          let record: Readonly<{
            id?: unknown;
            type?: unknown;
            command?: unknown;
            success?: unknown;
            data?: unknown;
          }>;
          try {
            record = JSON.parse(line) as typeof record;
          } catch {
            finish(new Error('Current Pi native resume emitted malformed JSONL'));
            return;
          }
          if (record.id !== 'external-sessions-pi-native-resume') continue;
          if (
            record.type !== 'response'
            || record.command !== 'get_state'
            || record.success !== true
            || !record.data
            || typeof record.data !== 'object'
            || Array.isArray(record.data)
          ) {
            finish(new Error('Current Pi native resume returned an invalid get_state response'));
            return;
          }
          const data = record.data as Record<string, unknown>;
          if (
            typeof data.sessionFile !== 'string'
            || typeof data.sessionId !== 'string'
            || typeof data.messageCount !== 'number'
          ) {
            finish(new Error('Current Pi native resume get_state omitted session identity'));
            return;
          }
          finish({
            sessionFile: data.sessionFile,
            sessionId: data.sessionId,
            messageCount: data.messageCount,
          });
          return;
        }
      });

      child.stdin.write(`${JSON.stringify({
        type: 'get_state',
        id: 'external-sessions-pi-native-resume',
      })}\n`);
    });
    return state;
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
      const timeout = setTimeout(() => resolve(), 5_000);
      timeout.unref();
    });
  }
}

describe('engineRegistry (Pi current local External Sessions resume)', () => {
  const liveIt = liveSessionFile ? it : it.skip;

  liveIt(
    'discovers, links, admits, and natively resumes one disposable copy with exact --session',
    async () => {
      await withTempDir('happier-pi-external-live-', async (directory) => {
        const agentDir = join(directory, 'pi-agent');
        const sessionRoot = join(agentDir, 'sessions', '--external-sessions-live--');
        const copiedSessionFile = join(sessionRoot, basename(liveSessionFile));
        const homeDir = join(directory, 'home');
        await mkdir(sessionRoot, { recursive: true });
        await mkdir(homeDir, { recursive: true });
        await copyFile(liveSessionFile, copiedSessionFile);
        const canonicalSessionFile = await realpath(copiedSessionFile);

        const contributions = createResolvedContributionRegistry(
          resolveBuiltInContributions(),
        );
        const envScope = createEnvKeyScope(['PI_CODING_AGENT_DIR']);
        envScope.patch({ PI_CODING_AGENT_DIR: agentDir });
        let runtimeRegistry: Awaited<
          ReturnType<typeof resolveExecutablePluginRuntimeRegistry>
        > | null = null;
        try {
          runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            contributes: contributions,
            happyHomeDir: join(directory, 'happier-home'),
            pluginIds: [PI_PLUGIN_ID],
          });
          const resolution = await resolveBackendEngineAdapterResolution(
            PI_AGENT_ID,
            { runtimeRegistry },
          );
          const externalSession = resolution?.executionSurfaces.externalSession;
          if (!externalSession) {
            throw new Error('Expected current Pi External Sessions execution surface');
          }

          const resolvedSource = await externalSession.validateSource!({
            source: { kind: 'piAgentDir' },
          });
          expect(resolvedSource).toMatchObject({
            ok: true,
            source: {
              kind: 'piAgentDir',
              agentDir: await realpath(agentDir),
            },
          });
          if (!resolvedSource.ok) return;

          const candidates = await externalSession.listCandidates!({
            source: resolvedSource.source,
            limit: 10,
          });
          expect(candidates.candidates).toHaveLength(1);
          const candidate = candidates.candidates[0];
          if (!candidate?.linkData) {
            throw new Error('Expected current Pi candidate link data');
          }

          const linked = await externalSession.resolveLinkIdentity!({
            source: resolvedSource.source,
            remoteSessionId: candidate.remoteSessionId,
            metadata: { linkData: candidate.linkData },
          });
          expect(linked).toMatchObject({
            source: {
              kind: 'piAgentDir',
              sessionFile: canonicalSessionFile,
            },
            remoteSessionId: candidate.remoteSessionId,
            runtimeDescriptor: {
              v: 1,
              agentId: PI_AGENT_ID,
              agent: {
                resumeStrategy: 'sessionFileAbsolutePreferred',
                providerSessionId: candidate.remoteSessionId,
                sessionFile: canonicalSessionFile,
              },
            },
          });

          const page = await externalSession.pageTranscript!({
            source: linked.source,
            remoteSessionId: linked.remoteSessionId,
            direction: 'older',
            maxBytes: 1024 * 1024,
            maxItems: 100,
          });
          expect(page.tailCursor).toMatch(/^happier_external_cursor_v1:/);
          expect(page.items.every((item) => TranscriptRawRecordV1Schema.safeParse(item.raw).success))
            .toBe(true);

          const definition = contributions.agentDefinitionsById.get(PI_AGENT_ID);
          const identity = definition?.identity;
          const sourceKinds = definition?.richDefinition?.definition.surfaces
            ?.externalSession?.sources.map((source) => source.sourceKind);
          if (!identity || !sourceKinds) {
            throw new Error('Expected current Pi contribution identity and source kinds');
          }
          const unresolvedLinkData = linked.externalSessionMetadata?.linkData;
          if (!unresolvedLinkData) {
            throw new Error('Expected canonical current Pi link data');
          }
          const linkData = PluginAgentExternalSessionLinkDataSchema.parse(
            unresolvedLinkData,
          );
          const metadata = buildLinkedExternalSessionMetadataV1({
            piSessionId: linked.remoteSessionId,
            runtimeDescriptorV1: linked.runtimeDescriptor,
          }, {
            v: 1,
            agentId: PI_AGENT_ID,
            machineId: 'external-sessions-pi-live',
            remoteSessionId: linked.remoteSessionId,
            source: linked.source,
            qualifiedIdentity: buildLinkedExternalSessionQualifiedIdentityV1({
              agent: identity,
              sourceKind: linked.source.kind,
            }),
            linkData,
            runtimeDescriptorV1: linked.runtimeDescriptor ?? undefined,
          });
          const eligibility = evaluateVendorResumeEligibility({
            agentId: PI_AGENT_ID,
            metadata,
            accountSettings: {},
            linkedSessionCurrentAgent: { identity, sourceKinds },
          });
          expect(eligibility).toEqual({
            eligible: true,
            vendorResumeId: canonicalSessionFile,
          });
          if (!eligibility.eligible) return;

          const args = buildPiRpcArgs({
            resumeSessionId: eligibility.vendorResumeId,
          });
          expect(args.slice(-2)).toEqual([
            '--session',
            canonicalSessionFile,
          ]);
          const state = await openCurrentPiSession({
            executable: livePiExecutable,
            args,
            agentDir,
            homeDir,
          });
          expect(state).toEqual({
            sessionFile: canonicalSessionFile,
            sessionId: candidate.remoteSessionId,
            messageCount: page.items.filter((item) => item.messageRole).length,
          });
        } finally {
          await runtimeRegistry?.dispose();
          envScope.restore();
        }
      });
    },
    45_000,
  );
});
