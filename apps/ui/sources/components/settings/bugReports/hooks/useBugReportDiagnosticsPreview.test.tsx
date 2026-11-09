import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { installBugReportHooksCommonModuleMocks } from './bugReportHooksTestHelpers';

const alert = vi.hoisted(() => vi.fn(async () => {}));
const show = vi.hoisted(() => vi.fn(() => 'preview'));
installBugReportHooksCommonModuleMocks({
  modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { alert, show } }).module,
});
const { useBugReportDiagnosticsPreview } = await import('./useBugReportDiagnosticsPreview');
afterEach(async () => { await standardCleanup(); alert.mockClear(); show.mockClear(); });

describe('diagnostic preview collection lifecycle', () => {
  it('does not present an obsolete preview or error when the report selection supersedes collection', async () => {
    const superseded = Object.assign(new Error('bug_report_diagnostics_superseded'), { name: 'AbortError' });
    const hook = await renderHook(() => useBugReportDiagnosticsPreview({
      disabled: false, includeDiagnostics: true, selectedKinds: ['ui-mobile'],
      collectDiagnosticsArtifacts: async () => { throw superseded; },
    }));
    await act(async () => hook.getCurrent().handlePreview());
    expect(show).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(hook.getCurrent().previewing).toBe(false);
  });
});
