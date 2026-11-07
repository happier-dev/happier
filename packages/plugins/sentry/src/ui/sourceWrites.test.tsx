// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { TriageSourceWrites, TriagePostMutationCompletionProvider } from '@happier-dev/triage-sources/ui';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('composed source writes', () => {
  it('holds a property after an unknown write and reconciles exactly once through the group owner', async () => {
    let state: Parameters<NonNullable<React.ComponentProps<typeof TriageSourceWrites>['children']>>[0] | undefined;
    let completions = 0;
    let fixture: Awaited<ReturnType<typeof createPluginUiTestkit>> | undefined;
    try {
      await act(async () => { fixture = await createPluginUiTestkit({
        identity: { instanceId: 'composed-writes', mountNonce: 'composed-writes-mount' },
        authorPlugin: { id: 'example.source', version: '0.0.0' },
        surface: defineUiSurface(() => <TriagePostMutationCompletionProvider onComplete={async () => { completions += 1; }}>
          <TriageSourceWrites writes={[]} sourceName="Example">{value => { state = value; return null; }}</TriageSourceWrites>
        </TriagePostMutationCompletionProvider>),
        surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      }); });
      expect(state?.held).toBe(false);
      await act(async () => { expect(state?.settle('assignment', { ok: false, errorCode: 'outcome_unknown', error: 'Connection lost', effectAttempted: true })).toEqual({ kind: 'uncertain' }); });
      expect(state?.held).toBe(true);
      expect(completions).toBe(1);
    } finally { await fixture?.dispose(); }
  });
});
