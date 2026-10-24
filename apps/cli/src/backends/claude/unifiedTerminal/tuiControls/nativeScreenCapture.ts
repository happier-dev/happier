import { normalizeCapturedScreen } from '@/integrations/terminalHost/controlCapture';

/** Claude 309 can draw its session-title rule below the active native dialog footer. */
export function readClaudeNativeDialogScreenLines(text: string): string[] {
    const lines = normalizeCapturedScreen(text).split('\n');
    if (/^\s*[─━]{2,}\s+\S.*\s+[─━]+\s*$/u.test(lines.at(-1) ?? '')) lines.pop();
    return lines;
}
