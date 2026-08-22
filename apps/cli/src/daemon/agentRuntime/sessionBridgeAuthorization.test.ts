import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
  createForegroundAgentRuntimeBootstrapAuthorization,
  createAgentRuntimeDaemonServiceAuthorityPath,
  createRunnerAgentSessionBootstrapAuthorization,
  hashAgentRuntimeSessionBridgeToken,
  publishAgentRuntimeDaemonServiceAuthority,
  readAgentRuntimeDaemonServiceAuthority,
  readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker,
  readCurrentRunnerAgentRuntimeDaemonServiceAuthority,
  readLiveRunnerAgentDaemonServiceAuthorityRetainedGenerationIds,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned,
  verifyAgentRuntimeSessionBridgeToken,
} from './sessionBridgeAuthorization';
import { hashProcessCommand } from '@/daemon/sessionRegistry';

const processIdentityMock = vi.hoisted(() => vi.fn());
vi.mock('@/daemon/processIdentity', () => ({
  readProcessIdentityByPid: processIdentityMock,
}));

const roots: string[] = [];

function createRetainedAgent() {
  return createAgentSessionRunnerFactoryBinding({
    v: 1,
    pluginId: 'acme.plugin',
    pluginVersion: '1.2.3',
    agentId: 'acme-agent',
    localAgentId: 'acme-agent',
    immutableGenerationId: `sha256:${'1'.repeat(64)}`,
    locator: {
      module: './runtime.mjs',
      export: 'createRuntime',
      runtimeApiVersion: 1,
    },
    normalizedModulePath: '/immutable/acme/runtime.mjs',
    loadMode: 'immutable-js',
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('Agent runtime session bridge authorization', () => {
  it('publishes direct retained runner correspondence without a grant or binding digest', async () => {
    const happyHomeDir = await mkdtemp(join(
      tmpdir(),
      'happier-direct-runner-authority-',
    ));
    roots.push(happyHomeDir);
    const path = await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir,
      publicReleaseRing: 'stable',
    });
    const directAuthorityInput = {
      path,
      happyHomeDir,
      publicReleaseRing: 'stable' as const,
      sessionId: 'session-direct-1',
      runner: {
        pid: 1234,
        processStartTimeMs: 1_717_171_717_000,
        processCommandHash: 'a'.repeat(64),
        snapshotIdentity: 'snapshot:runner-a',
      },
      retainedAgent: createRetainedAgent(),
    };

    const published = await publishAgentRuntimeDaemonServiceAuthority({
      ...directAuthorityInput,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });

    expect(published.document).toMatchObject({
      v: 2,
      sessionId: 'session-direct-1',
      runner: directAuthorityInput.runner,
      retainedAgent: directAuthorityInput.retainedAgent,
      pluginHardRevocationRevision: 0,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });
    expect(JSON.stringify(published.document)).not.toContain(
      'grantDigest',
    );
    expect(JSON.stringify(published.document)).not.toContain(
      'runtimeBindingDigest',
    );
  });

  it('retains an exact pre-marker Agent generation from its private authority document until its runner is verified stopped', async () => {
    const happyHomeDir = await mkdtemp(join(
      tmpdir(),
      'happier-pre-marker-runner-authority-',
    ));
    roots.push(happyHomeDir);
    const retainedAgent = createRetainedAgent();
    const runner = {
      pid: 1234,
      processStartTimeMs: 1_717_171_717_000,
      processCommandHash: 'a'.repeat(64),
      snapshotIdentity: 'snapshot:runner-a',
    };
    const path = await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir,
      publicReleaseRing: 'stable',
    });
    await publishAgentRuntimeDaemonServiceAuthority({
      path,
      happyHomeDir,
      publicReleaseRing: 'stable',
      sessionId: 'session-pre-marker-1',
      runner,
      retainedAgent,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });

    await expect(
      readLiveRunnerAgentDaemonServiceAuthorityRetainedGenerationIds({
        happyHomeDir,
        publicReleaseRing: 'stable',
        verifyRunnerLiveness: async (candidate) => ({
          status: 'verified_running',
          pid: candidate.pid,
          processStartTimeMs: candidate.processStartTimeMs,
        }),
      }),
    ).resolves.toEqual(new Set([
      retainedAgent.immutableGenerationId,
    ]));
    await expect(
      readLiveRunnerAgentDaemonServiceAuthorityRetainedGenerationIds({
        happyHomeDir,
        publicReleaseRing: 'stable',
        verifyRunnerLiveness: async (candidate) => ({
          status: 'verified_stopped',
          pid: candidate.pid,
          processStartTimeMs: candidate.processStartTimeMs,
        }),
      }),
    ).resolves.toEqual(new Set());
  });

  it('creates a descriptor-only runner bootstrap with a stable empty V2 authority path', async () => {
    const happyHomeDir = await mkdtemp(join(
      tmpdir(),
      'happier-runner-bootstrap-',
    ));
    roots.push(happyHomeDir);
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.grok',
      pluginVersion: '1.2.3',
      agentId: 'grok',
      backendId: 'grok',
      generation: 'generation-7',
    };

    const issued =
      await createRunnerAgentSessionBootstrapAuthorization({
        happyHomeDir,
        publicReleaseRing: 'stable',
        descriptor,
      });

    expect(issued.authorization).toMatchObject({ descriptor });
    expect(issued.childEnv).toEqual({
      HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE:
        issued.authorization.bootstrapFilePath,
      HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE:
        issued.authorization.authorityFilePath,
    });
    expect(issued.childEnv).not.toHaveProperty(
      'HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE',
    );
    expect(JSON.parse(await readFile(
      issued.authorization.bootstrapFilePath,
      'utf8',
    ))).toEqual({
      v: 1,
      descriptor,
    });
    await expect(stat(
      issued.authorization.authorityFilePath,
    )).rejects.toMatchObject({ code: 'ENOENT' });

    await issued.cleanupBootstrapFile();
    await expect(stat(
      issued.authorization.bootstrapFilePath,
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a foreground capability out of the retired whole-session bridge environment', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-bridge-auth-'));
    roots.push(happyHomeDir);
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.grok',
      pluginVersion: '1.2.3',
      agentId: 'grok',
      backendId: 'grok',
      generation: 'generation-7',
      immutableGenerationId: 'sha256:abc',
    };
    const issued = await createForegroundAgentRuntimeBootstrapAuthorization({
      happyHomeDir,
      publicReleaseRing: 'stable',
      capability: 'secret-token',
      descriptor,
    });

    expect(issued.authorization).toMatchObject({
      capabilityHash: hashAgentRuntimeSessionBridgeToken('secret-token'),
      descriptor,
    });
    expect(issued.childEnv).toEqual({
      HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE:
        issued.authorization.authorityFilePath,
      HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE:
        issued.authorization.bootstrapFilePath,
    });
    expect(issued.authorization).not.toHaveProperty('tokenFilePath');
    expect(JSON.parse(await readFile(
      issued.authorization.bootstrapFilePath,
      'utf8',
    ))).toEqual({
      v: 1,
      descriptor,
    });
    expect(JSON.parse(await readFile(
      issued.authorization.foregroundAdmissionFilePath,
      'utf8',
    ))).toEqual({
      v: 1,
      capability: 'secret-token',
      descriptor,
    });
    if (process.platform !== 'win32') {
      expect((await stat(
        issued.authorization.bootstrapFilePath,
      )).mode & 0o777).toBe(0o600);
      expect((await stat(
        issued.authorization.foregroundAdmissionFilePath,
      )).mode & 0o777).toBe(0o600);
    }

    await issued.cleanupBootstrapFiles();
    await expect(stat(
      issued.authorization.bootstrapFilePath,
    )).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(
      issued.authorization.foregroundAdmissionFilePath,
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('atomically rotates one strict endpoint/capability document at a stable path', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-authority-'));
    roots.push(happyHomeDir);
    const path = await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir,
      publicReleaseRing: 'stable',
    });
    const common = {
      path,
      happyHomeDir,
      publicReleaseRing: 'stable' as const,
      sessionId: 'session-1',
      runner: {
        pid: 1234,
        processStartTimeMs: 1_717_171_717_000,
        processCommandHash: 'a'.repeat(64),
        snapshotIdentity: 'snapshot:runner-a',
      },
    };
    const authority = {
      ...common,
      retainedAgent: createRetainedAgent(),
    };

    const daemonA = await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });
    expect(await readAgentRuntimeDaemonServiceAuthority(authority)).toEqual({
      v: 2,
      sessionId: 'session-1',
      runner: common.runner,
      retainedAgent: authority.retainedAgent,
      pluginHardRevocationRevision: 0,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });

    const daemonB = await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_002,
      capability: 'B'.repeat(43),
    });
    expect(daemonB.path).toBe(daemonA.path);
    expect(await readAgentRuntimeDaemonServiceAuthority(authority)).toMatchObject({
      httpPort: 31_002,
      capability: 'B'.repeat(43),
      retainedAgent: daemonA.document.retainedAgent,
    });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      httpPort: 31_002,
      capability: 'B'.repeat(43),
    });
  });

  it('rejects strict-schema, path, runner, binding, symlink, and mode substitutions', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-authority-'));
    roots.push(happyHomeDir);
    const path = await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir,
      publicReleaseRing: 'stable',
    });
    const expected = {
      path,
      happyHomeDir,
      publicReleaseRing: 'stable' as const,
      sessionId: 'session-1',
      runner: {
        pid: 1234,
        processStartTimeMs: 1_717_171_717_000,
        processCommandHash: 'a'.repeat(64),
        snapshotIdentity: 'snapshot:runner-a',
      },
    };
    const authority = {
      ...expected,
      retainedAgent: createRetainedAgent(),
    };
    await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });

    const malformedAuthority = JSON.parse(
      await readFile(path, 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({
      ...malformedAuthority,
      retainedAgent: [authority.retainedAgent],
    }), { mode: 0o600 });
    await expect(
      readAgentRuntimeDaemonServiceAuthority(authority),
    ).resolves.toBeNull();
    await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });

    await expect(readAgentRuntimeDaemonServiceAuthority({
      ...expected,
      ...authority,
      sessionId: 'session-2',
    })).resolves.toBeNull();
    await expect(readAgentRuntimeDaemonServiceAuthority({
      ...expected,
      ...authority,
      runner: { ...expected.runner, pid: 4321 },
    })).resolves.toBeNull();
    await expect(readAgentRuntimeDaemonServiceAuthority({
      ...expected,
      ...authority,
      runner: {
        ...expected.runner,
        processStartTimeMs: expected.runner.processStartTimeMs + 1,
      },
    })).resolves.toBeNull();
    await expect(readAgentRuntimeDaemonServiceAuthority({
      ...expected,
      ...authority,
      runner: {
        ...expected.runner,
        processCommandHash: 'c'.repeat(64),
      },
    })).resolves.toBeNull();
    await expect(readAgentRuntimeDaemonServiceAuthority({
      ...expected,
      ...authority,
      runner: {
        ...expected.runner,
        snapshotIdentity: 'snapshot:runner-b',
      },
    })).resolves.toBeNull();
    await expect(readAgentRuntimeDaemonServiceAuthority({
      ...authority,
      retainedAgent: {
        ...authority.retainedAgent,
        immutableGenerationId:
          'generation-successor-must-rematerialize',
      },
    })).resolves.toBeNull();
    await expect(readAgentRuntimeDaemonServiceAuthority({
      ...authority,
      path: join(happyHomeDir, 'substituted.json'),
    })).resolves.toBeNull();

    const realPath = `${path}.real`;
    await rm(realPath, { force: true });
    await import('node:fs/promises').then(({ rename }) => rename(path, realPath));
    await symlink(realPath, path);
    await expect(readAgentRuntimeDaemonServiceAuthority(authority)).resolves.toBeNull();
    await rm(path, { force: true });
    await import('node:fs/promises').then(({ rename }) => rename(realPath, path));

    if (process.platform !== 'win32') {
      await chmod(path, 0o644);
      await expect(readAgentRuntimeDaemonServiceAuthority(authority)).resolves.toBeNull();
    }
  });

  it('rejects a persisted authority document without its hard-revocation revision', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-authority-'));
    roots.push(happyHomeDir);
    const authority = {
      path: await createAgentRuntimeDaemonServiceAuthorityPath({
        happyHomeDir,
        publicReleaseRing: 'stable',
      }),
      happyHomeDir,
      publicReleaseRing: 'stable' as const,
      sessionId: 'session-1',
      runner: {
        pid: 1234,
        processStartTimeMs: 1_717_171_717_000,
        processCommandHash: 'a'.repeat(64),
        snapshotIdentity: 'snapshot:runner-a',
      },
      retainedAgent: createRetainedAgent(),
    };
    await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });
    const missingRevision = JSON.parse(
      await readFile(authority.path, 'utf8'),
    ) as Record<string, unknown>;
    delete missingRevision.pluginHardRevocationRevision;
    await writeFile(authority.path, JSON.stringify(missingRevision), {
      mode: 0o600,
    });

    await expect(
      readAgentRuntimeDaemonServiceAuthority(authority),
    ).resolves.toBeNull();
    await expect(
      readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
        happyHomeDir,
        publicReleaseRing: 'stable',
        path: authority.path,
        sessionId: authority.sessionId,
        runner: {
          pid: authority.runner.pid,
          processStartTimeMs: authority.runner.processStartTimeMs,
          processCommandHash: authority.runner.processCommandHash,
        },
      }),
    ).resolves.toBeNull();
  });

  it('does not let daemon A cleanup delete daemon B publication', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-authority-'));
    roots.push(happyHomeDir);
    const path = await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir,
      publicReleaseRing: 'stable',
    });
    const common = {
      path,
      happyHomeDir,
      publicReleaseRing: 'stable' as const,
      sessionId: 'session-1',
      runner: {
        pid: 1234,
        processStartTimeMs: 1_717_171_717_000,
        processCommandHash: 'a'.repeat(64),
        snapshotIdentity: 'snapshot:runner-a',
      },
    };
    const authority = {
      ...common,
      retainedAgent: createRetainedAgent(),
    };
    const daemonA = await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });
    const daemonB = await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_002,
      capability: 'B'.repeat(43),
    });

    await expect(removeAgentRuntimeDaemonServiceAuthorityIfOwned({
      path,
      happyHomeDir,
      publicReleaseRing: 'stable',
      capabilityDigest: daemonA.capabilityDigest,
    })).resolves.toBe(false);
    await expect(readAgentRuntimeDaemonServiceAuthority(authority)).resolves.toMatchObject({
      httpPort: 31_002,
      capability: 'B'.repeat(43),
    });
    await expect(removeAgentRuntimeDaemonServiceAuthorityIfOwned({
      path,
      happyHomeDir,
      publicReleaseRing: 'stable',
      capabilityDigest: daemonB.capabilityDigest,
    })).resolves.toBe(true);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lets only the exact live runner read its retained authority document', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-authority-'));
    roots.push(happyHomeDir);
    const processCommand =
      '/tmp/.runner-snapshots/snapshot-a/package-dist/index.mjs session';
    const runner = {
      pid: process.pid,
      processStartTimeMs: 1_717_171_717_000,
      processCommandHash: hashProcessCommand(processCommand),
      snapshotIdentity: 'snapshot:snapshot-a',
    };
    const authority = {
      path: await createAgentRuntimeDaemonServiceAuthorityPath({
        happyHomeDir,
        publicReleaseRing: 'stable',
      }),
      happyHomeDir,
      publicReleaseRing: 'stable' as const,
      sessionId: 'session-1',
      runner,
      retainedAgent: createRetainedAgent(),
    };
    await publishAgentRuntimeDaemonServiceAuthority({
      ...authority,
      httpPort: 31_001,
      capability: 'A'.repeat(43),
    });
    processIdentityMock.mockResolvedValue({
      pid: process.pid,
      processStartTimeMs: runner.processStartTimeMs,
      command: processCommand,
    });

    await expect(
      readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
        path: authority.path,
        happyHomeDir,
        publicReleaseRing: 'stable',
        expectedSessionId: 'session-1',
      }),
    ).resolves.toMatchObject({
      sessionId: 'session-1',
      retainedAgent: authority.retainedAgent,
    });
    await expect(
      readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
        path: authority.path,
        happyHomeDir,
        publicReleaseRing: 'stable',
        expectedSessionId: 'session-2',
      }),
    ).resolves.toBeNull();
    processIdentityMock.mockResolvedValue({
      pid: process.pid,
      processStartTimeMs:
        runner.processStartTimeMs + 1,
      command: processCommand,
    });
    await expect(
      readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
        path: authority.path,
        happyHomeDir,
        publicReleaseRing: 'stable',
      }),
    ).resolves.toBeNull();
  });

  it('verifies only the exact token against a canonical digest', () => {
    const expectedTokenHash = hashAgentRuntimeSessionBridgeToken('secret-token');
    expect(verifyAgentRuntimeSessionBridgeToken({
      providedToken: 'secret-token',
      expectedTokenHash,
    })).toBe(true);
    expect(verifyAgentRuntimeSessionBridgeToken({
      providedToken: 'secret-token-2',
      expectedTokenHash,
    })).toBe(false);
    expect(verifyAgentRuntimeSessionBridgeToken({
      providedToken: 'secret-token',
      expectedTokenHash: 'sha256:not-a-digest',
    })).toBe(false);
  });
});
