import { describe, expect, it } from 'vitest';
import { withCodexNativeAttachFixture } from './runtime.nativeAttach.test-support.js';

describe('Codex native startup instruction replacement', () => {
  it('fails the open when native developer delivery is rejected', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      await expect(fixture.openConfiguredSession('retained-thread')).rejects.toThrow();
      expect(fixture.requests.some(request => request.method === 'thread/inject_items')).toBe(true);
      expect(fixture.requests.some(request => request.method === 'turn/start')).toBe(false);
    }, { threadInjectFailure: { code: -32601, message: 'Method not found' } });
  });
  it.each([undefined, 'daemonProxy'] as const)('delivers changed and removed plans as developer history before input (%s)', async appServerTransport => {
    const options: NonNullable<Parameters<typeof withCodexNativeAttachFixture>[1]> = { appServerTransport };
    // A complete plan must survive; additionalContext would truncate it upstream.
    const plans = ['PLAN_V2', 'PLAN_V3', `PLAN_V4\n${'instruction '.repeat(1500)}`, null];
    await withCodexNativeAttachFixture(async fixture => {
      for (const [revision, instructions] of plans.entries()) {
        options.startupInstructions = instructions === null ? null
          : { v: 1, id: 'happier.coding_session_plan', revision: revision + 1, instructions };
        const session = await fixture.openConfiguredSession('retained-thread');
        const injected = fixture.requests.filter(request => request.method === 'thread/inject_items').at(-1);
        expect(injected?.params).toMatchObject({ threadId: 'retained-thread', items: [{
          type: 'message', role: 'developer', content: [{ type: 'input_text', text: expect.any(String) }],
        }] });
        const text = (injected!.params.items as Array<{ content: Array<{ text: string }> }>)[0]!.content[0]!.text;
        expect(text).toContain('supersedes');
        if (instructions !== null) expect(text.endsWith(instructions)).toBe(true);
        else {
          expect(text).toContain('empty');
          expect(text).not.toContain('PLAN_V4');
        }
        await session.send({ inputIds: [`input-${revision}`], input: { text: 'current plan?' },
          delivery: { kind: 'newTurn', turnId: `turn-${revision}` } });
        await session.dispose();
      }
      const resumes = fixture.requests.filter(request => request.method === 'thread/resume');
      expect(resumes).toHaveLength(4);
      // Cold-session configuration must also stay current for later context rebuilding.
      expect(resumes.map(resume => resume.params.developerInstructions)).toEqual(plans.map(plan => plan ?? ''));
      expect(fixture.requests.filter(request => request.method === 'thread/inject_items')).toHaveLength(4);
      expect(fixture.requests.filter(request => request.method === 'turn/start').map(request => request.params.input))
        .toEqual(plans.map(() => [expect.objectContaining({ type: 'text', text: 'current plan?' })]));
      expect(fixture.nativeLaunches).toHaveLength(appServerTransport ? 0 : 4);
      expect(fixture.nativeProcessExits).toHaveLength(appServerTransport ? 0 : 4);
    }, options);
  });
});
