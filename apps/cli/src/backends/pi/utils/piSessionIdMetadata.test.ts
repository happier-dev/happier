import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { buildPiAgentRuntimeDescriptorV1 } from '@happier-dev/protocol';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { formatPiSessionDirectoryForCwd } from '@/backends/pi/utils/piSessionFiles';

import {
  maybeUpdatePiSessionIdMetadata,
  publishPiSessionIdMetadata,
  resolvePiSessionFileForRuntimeSession,
} from './piSessionIdMetadata';

describe('maybeUpdatePiSessionIdMetadata', () => {
  it.each([null, '', '   '])('does not publish metadata when session id is %p', async (sessionId) => {
    const lastPublished = { value: null as string | null };
    let metadata = createTestMetadata();
    let calls = 0;

    await maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => sessionId,
      getPiSessionFile: () => null,
      updateHappySessionMetadata: (updater) => {
        calls += 1;
        metadata = updater(metadata);
      },
      lastPublished,
    });

    expect(calls).toBe(0);
    expect(lastPublished.value).toBeNull();
    expect((metadata as Metadata & { piSessionId?: string }).piSessionId).toBeUndefined();
  });

  it('publishes trimmed session id once and preserves unrelated metadata', async () => {
    const lastPublished = { value: null as string | null };
    let metadata = createTestMetadata({ flavor: 'pi' });

    await maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => '  pi-session-1 ',
      getPiSessionFile: () => '  /tmp/pi/sessions/pi-session-1.jsonl ',
      updateHappySessionMetadata: (updater) => {
        metadata = updater(metadata);
      },
      lastPublished,
    });

    expect(lastPublished.value).toBe('pi-session-1');
    expect((metadata as Metadata & { piSessionId?: string }).piSessionId).toBe('pi-session-1');
    expect((metadata as Metadata & { piSessionFile?: string }).piSessionFile)
      .toBe('/tmp/pi/sessions/pi-session-1.jsonl');
    expect(metadata.agentRuntimeDescriptorV1).toEqual({
      v: 1,
      providerId: 'pi',
      provider: {
        resumeStrategy: 'sessionFileAbsolutePreferred',
        vendorSessionId: 'pi-session-1',
        sessionFile: '/tmp/pi/sessions/pi-session-1.jsonl',
      },
    });
    expect(metadata.flavor).toBe('pi');
  });

  it('does not update metadata when value is unchanged', async () => {
    const lastPublished = { value: null as string | null };
    let metadata = createTestMetadata();
    let calls = 0;

    await maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => 'pi-session-1',
      getPiSessionFile: () => null,
      updateHappySessionMetadata: (updater) => {
        calls += 1;
        metadata = updater(metadata);
      },
      lastPublished,
    });
    const snapshot = metadata;

    await maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => ' pi-session-1 ',
      getPiSessionFile: () => null,
      updateHappySessionMetadata: (updater) => {
        calls += 1;
        metadata = updater(metadata);
      },
      lastPublished,
    });

    expect(calls).toBe(1);
    expect(metadata).toBe(snapshot);
  });

  it('updates metadata when the same session id later publishes an absolute session file', async () => {
    const lastPublished = { value: null as string | null, sessionFile: null as string | null };
    let metadata = createTestMetadata();
    let calls = 0;

    await maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => 'pi-session-1',
      getPiSessionFile: () => null,
      updateHappySessionMetadata: (updater) => {
        calls += 1;
        metadata = updater(metadata);
      },
      lastPublished,
    });

    await maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => 'pi-session-1',
      getPiSessionFile: () => '/tmp/pi/sessions/pi-session-1.jsonl',
      updateHappySessionMetadata: (updater) => {
        calls += 1;
        metadata = updater(metadata);
      },
      lastPublished,
    });

    expect(calls).toBe(2);
    expect((metadata as Metadata & { piSessionFile?: string }).piSessionFile)
      .toBe('/tmp/pi/sessions/pi-session-1.jsonl');
    expect(metadata.agentRuntimeDescriptorV1).toEqual({
      v: 1,
      providerId: 'pi',
      provider: {
        resumeStrategy: 'sessionFileAbsolutePreferred',
        vendorSessionId: 'pi-session-1',
        sessionFile: '/tmp/pi/sessions/pi-session-1.jsonl',
      },
    });
  });

  it('clears stale piSessionFile when publishing a new session id without a resolved file', async () => {
    const lastPublished = { value: null as string | null, sessionFile: null as string | null };
    let metadata = createTestMetadata({
      piSessionId: 'old-session',
      piSessionFile: '/tmp/pi/sessions/old-session.jsonl',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'pi',
        provider: {
          resumeStrategy: 'sessionFileAbsolutePreferred',
          vendorSessionId: 'old-session',
          sessionFile: '/tmp/pi/sessions/old-session.jsonl',
        },
      },
    } as Partial<Metadata>);

    await maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => 'new-session',
      getPiSessionFile: () => null,
      updateHappySessionMetadata: (updater) => {
        metadata = updater(metadata);
      },
      lastPublished,
    });

    expect((metadata as Metadata & { piSessionFile?: string }).piSessionFile).toBeUndefined();
    expect(metadata.agentRuntimeDescriptorV1).toEqual({
      v: 1,
      providerId: 'pi',
      provider: {
        resumeStrategy: 'sessionFileAbsolutePreferred',
        vendorSessionId: 'new-session',
      },
    });
  });

  it('resolves pi session files from PI_CODING_AGENT_DIR using the encoded cwd layout', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'pi-session-discovery-'));
    const cwd = join(tempRoot, 'repo');
    const encodedCwdDir = formatPiSessionDirectoryForCwd(cwd);
    const agentDir = join(tempRoot, 'pi-agent-dir');
    const sessionsDir = join(agentDir, 'sessions', encodedCwdDir);
    await mkdir(sessionsDir, { recursive: true });
    const sessionFile = join(sessionsDir, 'session-pi-session-1.jsonl');
    await writeFile(sessionFile, '{}\n');

    const resolved = await resolvePiSessionFileForRuntimeSession({
      vendorSessionReference: 'pi-session-1',
      cwd,
      processEnv: {
        PI_CODING_AGENT_DIR: agentDir,
      },
    });

    expect(resolved).toBe(sessionFile);
  });

  it('publishes piSessionFile via runtime session discovery when available', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'pi-session-publish-'));
    const cwd = join(tempRoot, 'repo');
    const encodedCwdDir = formatPiSessionDirectoryForCwd(cwd);
    const agentDir = join(tempRoot, 'pi-agent-dir');
    const sessionsDir = join(agentDir, 'sessions', encodedCwdDir);
    await mkdir(sessionsDir, { recursive: true });
    const sessionFile = join(sessionsDir, 'session-pi-session-1.jsonl');
    await writeFile(sessionFile, '{}\n');

    const lastPublished = { value: null as string | null, sessionFile: null as string | null };
    let metadata = createTestMetadata({ flavor: 'pi' });

    await publishPiSessionIdMetadata({
      operation: 'create',
      session: {
        updateMetadata: (updater) => {
          metadata = updater(metadata);
        },
        getMetadataSnapshot: () => metadata,
      },
      getPiSessionId: () => 'pi-session-1',
      cwd,
      processEnv: {
        PI_CODING_AGENT_DIR: agentDir,
      },
      lastPublished,
    });

    await vi.waitFor(() => {
      expect((metadata as Metadata & { piSessionFile?: string }).piSessionFile).toBe(sessionFile);
      expect(metadata.agentRuntimeDescriptorV1).toEqual({
        v: 1,
        providerId: 'pi',
        provider: {
          resumeStrategy: 'sessionFileAbsolutePreferred',
          vendorSessionId: 'pi-session-1',
          sessionFile,
        },
      });
    });
  });

  it('retries session-file discovery and publishes piSessionFile when the file appears shortly after startup', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'pi-session-retry-'));
    const cwd = join(tempRoot, 'repo');
    const encodedCwdDir = formatPiSessionDirectoryForCwd(cwd);
    const agentDir = join(tempRoot, 'pi-agent-dir');
    const sessionsDir = join(agentDir, 'sessions', encodedCwdDir);
    await mkdir(sessionsDir, { recursive: true });
    const sessionFile = join(sessionsDir, 'session-pi-session-1.jsonl');

    const lastPublished = { value: null as string | null, sessionFile: null as string | null };
    let metadata = createTestMetadata({ flavor: 'pi' });

    await publishPiSessionIdMetadata({
      operation: 'create',
      session: {
        updateMetadata: (updater) => {
          metadata = updater(metadata);
        },
        getMetadataSnapshot: () => metadata,
      },
      getPiSessionId: () => 'pi-session-1',
      cwd,
      processEnv: {
        PI_CODING_AGENT_DIR: agentDir,
      },
      lastPublished,
    });

    setTimeout(() => {
      void writeFile(sessionFile, '{}\n');
    }, 100);

    await vi.waitFor(() => {
      expect((metadata as Metadata & { piSessionFile?: string }).piSessionFile).toBe(sessionFile);
    }, { timeout: 4_000 });
  });

  it('reverts lastPublished when the metadata update fails', async () => {
    const lastPublished = { value: null as string | null, sessionFile: null as string | null };
    let calls = 0;

    await expect(maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => 'pi-session-1',
      getPiSessionFile: () => null,
      updateHappySessionMetadata: async () => {
        calls += 1;
        throw new Error('update failed');
      },
      lastPublished,
    })).rejects.toThrow('update failed');

    expect(calls).toBe(1);
    expect(lastPublished.value).toBeNull();
    expect(lastPublished.sessionFile).toBeNull();
  });

  it('skips the mandatory write for an exact durable resume and preserves its session file', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'pi-session-durable-resume-'));
    const sessionFile = join(tempRoot, 'session-pi-resume-1.jsonl');
    await writeFile(sessionFile, '{}\n');
    const metadata = createTestMetadata({
      piSessionId: ' pi-resume-1 ',
      piSessionFile: sessionFile,
      agentRuntimeDescriptorV1: buildPiAgentRuntimeDescriptorV1({
        resumeStrategy: 'sessionFileAbsolutePreferred',
        vendorSessionId: 'pi-resume-1',
        sessionFile,
      }),
    } as Partial<Metadata>);
    const updateMetadata = vi.fn(async () => {
      throw new Error('metadata unavailable');
    });
    const lastPublished = { value: null as string | null, sessionFile: null as string | null };

    await expect(publishPiSessionIdMetadata({
      operation: 'resume',
      session: { updateMetadata, getMetadataSnapshot: () => metadata },
      getPiSessionId: () => ' pi-resume-1 ',
      cwd: tempRoot,
      processEnv: { PI_CODING_AGENT_DIR: tempRoot },
      lastPublished,
    })).resolves.toBeUndefined();

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(updateMetadata).not.toHaveBeenCalled();
    expect(lastPublished).toEqual({ value: 'pi-resume-1', sessionFile });
    expect(metadata.piSessionFile).toBe(sessionFile);
  });

  it('preserves a valid matching persisted session file while repairing incomplete resume metadata', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'pi-session-repair-resume-'));
    const persistedDir = join(tempRoot, 'persisted-outside-standard-roots');
    await mkdir(persistedDir, { recursive: true });
    const sessionFile = join(persistedDir, 'session-pi-resume-1.jsonl');
    await writeFile(sessionFile, '{}\n');

    let metadata = createTestMetadata({
      piSessionId: 'pi-resume-1',
      piSessionFile: sessionFile,
    } as Partial<Metadata>);
    const updateMetadata = vi.fn(async (updater: (current: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });

    await publishPiSessionIdMetadata({
      operation: 'resume',
      session: { updateMetadata, getMetadataSnapshot: () => metadata },
      getPiSessionId: () => 'pi-resume-1',
      cwd: join(tempRoot, 'worktree'),
      processEnv: { PI_CODING_AGENT_DIR: join(tempRoot, 'empty-agent-root') },
      lastPublished: { value: null, sessionFile: null },
    });

    expect(updateMetadata).toHaveBeenCalledTimes(1);
    expect(metadata.piSessionFile).toBe(sessionFile);
    expect(metadata.agentRuntimeDescriptorV1).toEqual(buildPiAgentRuntimeDescriptorV1({
      resumeStrategy: 'sessionFileAbsolutePreferred',
      vendorSessionId: 'pi-resume-1',
      sessionFile,
    }));
  });

  it('preserves a descriptor-only persisted session file while repairing its missing top-level alias', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'pi-session-descriptor-only-repair-'));
    const persistedDir = join(tempRoot, 'persisted-outside-standard-roots');
    await mkdir(persistedDir, { recursive: true });
    const sessionFile = join(persistedDir, 'session-pi-resume-1.jsonl');
    await writeFile(sessionFile, '{}\n');

    let metadata = createTestMetadata({
      piSessionId: 'pi-resume-1',
      agentRuntimeDescriptorV1: buildPiAgentRuntimeDescriptorV1({
        resumeStrategy: 'sessionFileAbsolutePreferred',
        vendorSessionId: 'pi-resume-1',
        sessionFile,
      }),
    } as Partial<Metadata>);
    const updateMetadata = vi.fn(async (updater: (current: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });

    await publishPiSessionIdMetadata({
      operation: 'resume',
      session: { updateMetadata, getMetadataSnapshot: () => metadata },
      getPiSessionId: () => 'pi-resume-1',
      cwd: join(tempRoot, 'worktree'),
      processEnv: { PI_CODING_AGENT_DIR: join(tempRoot, 'empty-agent-root') },
      lastPublished: { value: null, sessionFile: null },
    });

    expect(updateMetadata).toHaveBeenCalledTimes(1);
    expect(metadata.piSessionFile).toBe(sessionFile);
    expect(metadata.agentRuntimeDescriptorV1).toEqual(buildPiAgentRuntimeDescriptorV1({
      resumeStrategy: 'sessionFileAbsolutePreferred',
      vendorSessionId: 'pi-resume-1',
      sessionFile,
    }));
  });

  it('does not choose between conflicting persisted session-file surfaces during repair', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'pi-session-conflicting-repair-'));
    const firstDir = join(tempRoot, 'first-outside-standard-roots');
    const secondDir = join(tempRoot, 'second-outside-standard-roots');
    await mkdir(firstDir, { recursive: true });
    await mkdir(secondDir, { recursive: true });
    const topLevelFile = join(firstDir, 'session-pi-resume-1.jsonl');
    const descriptorFile = join(secondDir, 'session-pi-resume-1.jsonl');
    await writeFile(topLevelFile, '{}\n');
    await writeFile(descriptorFile, '{}\n');

    let metadata = createTestMetadata({
      piSessionId: 'pi-resume-1',
      piSessionFile: topLevelFile,
      agentRuntimeDescriptorV1: buildPiAgentRuntimeDescriptorV1({
        resumeStrategy: 'sessionFileAbsolutePreferred',
        vendorSessionId: 'pi-resume-1',
        sessionFile: descriptorFile,
      }),
    } as Partial<Metadata>);

    await publishPiSessionIdMetadata({
      operation: 'resume',
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: async (updater) => {
          metadata = updater(metadata);
        },
      },
      getPiSessionId: () => 'pi-resume-1',
      cwd: join(tempRoot, 'worktree'),
      processEnv: { PI_CODING_AGENT_DIR: join(tempRoot, 'empty-agent-root') },
      lastPublished: { value: null, sessionFile: null },
    });

    expect(metadata.piSessionFile).toBeUndefined();
    expect(metadata.agentRuntimeDescriptorV1).toEqual(buildPiAgentRuntimeDescriptorV1({
      resumeStrategy: 'sessionFileAbsolutePreferred',
      vendorSessionId: 'pi-resume-1',
    }));
  });

  it('repairs coherent session-file aliases that are missing or do not belong to the bound vendor id', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'pi-session-invalid-durable-file-'));
    const missingMatchingFile = join(tempRoot, 'session-pi-resume-1.jsonl');
    const existingWrongFile = join(tempRoot, 'session-another-id.jsonl');
    await writeFile(existingWrongFile, '{}\n');

    for (const sessionFile of [missingMatchingFile, existingWrongFile]) {
      let metadata = createTestMetadata({
        piSessionId: 'pi-resume-1',
        piSessionFile: sessionFile,
        agentRuntimeDescriptorV1: buildPiAgentRuntimeDescriptorV1({
          resumeStrategy: 'sessionFileAbsolutePreferred',
          vendorSessionId: 'pi-resume-1',
          sessionFile,
        }),
      } as Partial<Metadata>);
      const updateMetadata = vi.fn(async (updater: (current: Metadata) => Metadata) => {
        metadata = updater(metadata);
      });

      await publishPiSessionIdMetadata({
        operation: 'resume',
        session: { updateMetadata, getMetadataSnapshot: () => metadata },
        getPiSessionId: () => 'pi-resume-1',
        cwd: join(tempRoot, 'worktree'),
        processEnv: { PI_CODING_AGENT_DIR: join(tempRoot, 'empty-agent-root') },
        lastPublished: { value: null, sessionFile: null },
      });

      expect(updateMetadata).toHaveBeenCalledTimes(1);
      expect(metadata.piSessionFile).toBeUndefined();
      expect(metadata.agentRuntimeDescriptorV1).toEqual(buildPiAgentRuntimeDescriptorV1({
        resumeStrategy: 'sessionFileAbsolutePreferred',
        vendorSessionId: 'pi-resume-1',
      }));
    }
  });

  it.each([
    {
      name: 'create',
      operation: 'create' as const,
      metadata: createTestMetadata({
        piSessionId: 'pi-resume-1',
        agentRuntimeDescriptorV1: buildPiAgentRuntimeDescriptorV1({
          resumeStrategy: 'sessionFileAbsolutePreferred',
          vendorSessionId: 'pi-resume-1',
        }),
      } as Partial<Metadata>),
    },
    {
      name: 'resume with no rich descriptor',
      operation: 'resume' as const,
      metadata: createTestMetadata({ piSessionId: 'pi-resume-1' } as Partial<Metadata>),
    },
    {
      name: 'resume with a mismatched rich descriptor',
      operation: 'resume' as const,
      metadata: createTestMetadata({
        piSessionId: 'pi-resume-1',
        agentRuntimeDescriptorV1: buildPiAgentRuntimeDescriptorV1({
          resumeStrategy: 'sessionFileAbsolutePreferred',
          vendorSessionId: 'different-session',
        }),
      } as Partial<Metadata>),
    },
  ])('requires an acknowledged write for $name', async ({ operation, metadata }) => {
    const updateMetadata = vi.fn(async () => {
      throw new Error('metadata unavailable');
    });

    await expect(publishPiSessionIdMetadata({
      operation,
      session: { updateMetadata, getMetadataSnapshot: () => metadata },
      getPiSessionId: () => 'pi-resume-1',
      cwd: '/tmp',
      processEnv: {},
      lastPublished: { value: null, sessionFile: null },
    })).rejects.toThrow('metadata unavailable');
    expect(updateMetadata).toHaveBeenCalledTimes(1);
  });

  it('retries a non-durable resume after a failed acknowledged write', async () => {
    let metadata = createTestMetadata({ piSessionId: 'pi-resume-1' } as Partial<Metadata>);
    const updateMetadata = vi.fn()
      .mockRejectedValueOnce(new Error('metadata unavailable'))
      .mockImplementationOnce(async (updater: (current: Metadata) => Metadata) => {
        metadata = updater(metadata);
      });
    const params = {
      operation: 'resume' as const,
      session: { updateMetadata, getMetadataSnapshot: () => metadata },
      getPiSessionId: () => 'pi-resume-1',
      cwd: '/tmp',
      processEnv: {},
      lastPublished: { value: null as string | null, sessionFile: null as string | null },
    };

    await expect(publishPiSessionIdMetadata(params)).rejects.toThrow('metadata unavailable');
    await expect(publishPiSessionIdMetadata(params)).resolves.toBeUndefined();

    expect(updateMetadata).toHaveBeenCalledTimes(2);
    expect(metadata.agentRuntimeDescriptorV1).toEqual(buildPiAgentRuntimeDescriptorV1({
      resumeStrategy: 'sessionFileAbsolutePreferred',
      vendorSessionId: 'pi-resume-1',
    }));
  });
});
