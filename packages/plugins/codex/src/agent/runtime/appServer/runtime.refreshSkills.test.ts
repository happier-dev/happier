import { describe, expect, it, vi } from 'vitest';
import { parse } from 'smol-toml';
import type { AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';

import { startCodexAppServerRuntime } from './runtime.js';
import { createCodexNativeAppServerSessionRuntime } from './native.js';
import { withCodexNativeAttachFixture } from './runtime.nativeAttach.test-support.js';

const skills: AgentSessionSkillDelivery = {
  pluginRoot: '/happier/skills/sessions/session-1',
  skillsRoot: '/happier/skills/sessions/session-1/skills',
  items: [{ name: 'review', skillId: 'skill-review', digest: `sha256:${'a'.repeat(64)}`, directory: '/happier/skills/sessions/session-1/skills/review' }],
  nativeDisables: [{ name: 'review', path: 'C:\\Users\\Test User\\.agents\\skills\\review\\SKILL.md' }],
};

describe('Codex session-private skill delivery', () => {
  it('keeps reload pending until the repeated extra-roots request is acknowledged', async () => {
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
    await withCodexNativeAttachFixture(async ({ runtime, requests }) => {
      await startCodexAppServerRuntime(runtime);
      const session = createCodexNativeAppServerSessionRuntime(runtime, 'session-1');
      const replacement = { ...skills, skillsRoot: '/happier/skills/sessions/session-1/replaced-skills' };
      let settled = false;
      const refresh = session.refreshSkills!({ skills: replacement }).then(result => { settled = true; return result; });
      try {
        await vi.waitFor(() => expect(requests.filter(({ method }) => method === 'skills/extraRoots/set')).toHaveLength(2));
        await Promise.resolve();
        expect(settled).toBe(false);
        acknowledge();
        expect(await refresh).toEqual({ kind: 'applied' });
        expect(requests.filter(({ method }) => method === 'skills/extraRoots/set').at(-1)?.params)
          .toEqual({ extraRoots: [replacement.skillsRoot] });
        expect(requests.some(({ method }) => method === 'skills/config/write')).toBe(false);
      } finally { acknowledge(); await refresh; await session.dispose(); }
    }, { skills, beforeExtraRootsSetResponse: async ({ occurrence }) => {
      if (occurrence > 1) await acknowledgement;
    } });
  });

  it('cancels an unacknowledged reload without claiming it applied', async () => {
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
    await withCodexNativeAttachFixture(async ({ runtime, requests }) => {
      await startCodexAppServerRuntime(runtime);
      const session = createCodexNativeAppServerSessionRuntime(runtime, 'session-1');
      const abort = new AbortController();
      const cancelled = new Error('cancel reload');
      const cancelledSkills = { ...skills, skillsRoot: `${skills.skillsRoot}/cancelled` };
      const refresh = session.refreshSkills!({ skills: cancelledSkills }, { signal: abort.signal });
      const outcome = refresh.then(value => ({ kind: 'resolved', value }), error => ({ kind: 'rejected', error }));
      try {
        await vi.waitFor(() => expect(requests.filter(({ method }) => method === 'skills/extraRoots/set')).toHaveLength(2));
        abort.abort(cancelled);
        expect(await outcome).toMatchObject({ kind: 'rejected', error: { code: 'PLUGIN_EXEC_CLIENT_ABORTED' } });
        acknowledge();
        await expect(session.refreshSkills!({ skills })).resolves.toEqual({ kind: 'applied' });
        expect(requests.filter(({ method }) => method === 'skills/extraRoots/set').at(-1)?.params)
          .toEqual({ extraRoots: [skills.skillsRoot] });
      } finally { acknowledge(); await session.dispose(); }
    }, { skills, beforeExtraRootsSetResponse: async ({ occurrence }) => {
      if (occurrence > 1) await acknowledgement;
    } });
  });

  it('sets extra roots before starting the thread and repeats the set for library reload', async () => {
    await withCodexNativeAttachFixture(async ({ runtime, requests }) => {
      await startCodexAppServerRuntime(runtime);
      const initialSet = requests.findIndex(({ method }) => method === 'skills/extraRoots/set');
      expect(initialSet).toBeGreaterThanOrEqual(0);
      expect(initialSet).toBeLessThan(requests.findIndex(({ method }) => method === 'thread/start'));
      expect(runtime.skillsDelivered).toBe(true);
      const session = createCodexNativeAppServerSessionRuntime(runtime, 'session-1');
      try {
        expect(session.skillsDelivered).toBe(true);
        expect(await session.refreshSkills?.({ skills })).toEqual({ kind: 'applied' });
        expect(requests.filter(({ method }) => method === 'skills/extraRoots/set').map(({ params }) => params))
          .toEqual([{ extraRoots: [skills.skillsRoot] }, { extraRoots: [skills.skillsRoot] }]);
        expect(requests.some(({ method }) => method === 'skills/config/write')).toBe(false);
      } finally { await session.dispose(); }
    }, { skills });
  });

  it('native Session open delivers skills and applies path disables only in launch config', async () => {
    await withCodexNativeAttachFixture(async ({ requests, nativeLaunches, openConfiguredSession }) => {
      const runtime = await openConfiguredSession();
      expect(runtime.skillsDelivered).toBe(true);
      expect(requests.filter(({ method }) => method === 'skills/extraRoots/set').map(({ params }) => params))
        .toEqual([{ extraRoots: [skills.skillsRoot] }]);
      const argv = nativeLaunches.flat();
      const config = argv.find((arg) => arg.startsWith('skills.config='));
      expect(config).toBeDefined();
      expect(parse(config!)).toEqual({ skills: { config: [{ path: skills.nativeDisables[0].path, enabled: false }] } });
    }, { skills });
  });

  it('daemon proxy reports unsupported delivery and reload without mutating the shared roots', async () => {
    await withCodexNativeAttachFixture(async ({ runtime, requests }) => {
      await startCodexAppServerRuntime(runtime);
      const session = createCodexNativeAppServerSessionRuntime(runtime, 'session-1');
      try {
        expect(session.skillsDelivered).toBe(false);
        expect(await session.refreshSkills?.({ skills })).toEqual({ kind: 'restart_required', reason: 'launch_path_unsupported' });
        expect(requests.some(({ method }) => method === 'skills/extraRoots/set')).toBe(false);
      } finally { await session.dispose(); }
    }, { skills, appServerTransport: 'daemonProxy' });
  });

  it('native Execution Run open applies its own skills and launch-only native disables', async () => {
    await withCodexNativeAttachFixture(async ({ requests, nativeLaunches, openConfiguredRun }) => {
      await openConfiguredRun();
      expect(requests.filter(({ method }) => method === 'skills/extraRoots/set').map(({ params }) => params))
        .toEqual([{ extraRoots: [skills.skillsRoot] }]);
      const config = nativeLaunches.flat().find((arg) => arg.startsWith('skills.config='));
      expect(config).toBeDefined();
      expect(parse(config!)).toEqual({ skills: { config: [{ path: skills.nativeDisables[0].path, enabled: false }] } });
    }, { skills });
  });

  it('keeps the session open when the Agent refuses the skills method', async () => {
    await withCodexNativeAttachFixture(async ({ runtime }) => {
      expect(await startCodexAppServerRuntime(runtime)).toBe('fresh-thread');
      expect(runtime.skillsDelivered).toBe(false);
      await expect(runtime.refreshSkills?.({ skills })).rejects.toThrow();
    }, { skills, rejectExtraRootsSet: true });
  });
});
