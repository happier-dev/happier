import * as React from 'react';
import type { ScmDiffArea } from '@happier-dev/protocol/scm/workingSnapshot';
import { resolveDefaultDiffModeForFile } from './defaultMode';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';

export function useFileDetailsDiffMode(input: Parameters<typeof resolveDefaultDiffModeForFile>[0] & { fileKey: string }) {
    const defaultMode = resolveDefaultDiffModeForFile(input);
    const availableModes = scmUiBackendRegistry.getPluginForSnapshot(input.snapshot).diffModeConfig(input.snapshot).availableModes.join(',');
    const context = `${input.fileKey}:${availableModes}:${defaultMode}:${input.hasIncludedDelta}:${input.hasPendingDelta}`;
    const [choice, setChoice] = React.useState({ context, mode: defaultMode });
    if (choice.context !== context) setChoice({ context, mode: defaultMode });
    const mode = choice.context === context ? choice.mode : defaultMode;
    const setMode = React.useCallback((next: ScmDiffArea) => setChoice({ context, mode: next }), [context]);
    return [mode, setMode] as const;
}
