import { readClaudeNativeDialogScreenLines } from './nativeScreenCapture';

export type ClaudeNativePermissionPresentation = Readonly<{
    kind: 'tool' | 'plan';
    context: string;
    /** Native text below the command block, when its closing rule is visible. */
    explanation?: string;
    options: readonly Readonly<{ label: string; focused: boolean }>[];
    amended: boolean;
    feedback?: Readonly<{ optionIndex: number; placeholder: string; text: string }>;
}>;

function lastLineIndex(lines: readonly string[], pattern: RegExp): number {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (pattern.test(lines[index]!)) return index;
    }
    return -1;
}

const PLAN_QUESTION = 'Claude has written up a plan and is ready to execute. Would you like to proceed?';
const NATIVE_PERMISSION_HEADER = /^\s*(?:Bash command|Create file|Read file|Read outside the working directories)\s*$/u;
const READ_OUTSIDE_CHOICES = [
    'Yes, and keep allowing any reads outside the working directories',
    'No, and block reads outside the working directories from now on',
    'No, and ask again next time',
    'Yes, but ask again next time',
];

/** Native permission UI, characterized with Bash/Write on Claude 2.1.304 and Read on 2.1.310. */
export function parseClaudeNativePermissionScreen(text: string): ClaudeNativePermissionPresentation | null {
    const lines = readClaudeNativeDialogScreenLines(text);
    const planFooter = lastLineIndex(lines, /^\s*ctrl\+g to edit in .+ ·(?: .*)?\s*$/u);
    const footerLines = planFooter >= 0 ? lines.slice(planFooter).filter((line) => line.trim()) : [];
    const planFooterComplete = footerLines.length > 0
        && /^ctrl\+g to edit in .+ · .+$/u.test(footerLines.map((line) => line.trim()).join(' '))
        && footerLines.slice(1).every((line) => /^\s{3,}\S/u.test(line));
    if (planFooterComplete) {
        const firstOption = lastLineIndex(lines.slice(0, planFooter), /^\s*([>›❯])?\s*1\.\s+Yes\b/u);
        if (firstOption < 0) return null;
        let question = -1;
        for (let index = firstOption - 1; index >= 0; index -= 1) {
            const text = lines.slice(index, firstOption).map((line) => line.trim()).filter(Boolean).join(' ');
            if (text === PLAN_QUESTION) { question = index; break; }
            if (text.length > PLAN_QUESTION.length) break;
        }
        if (question < 0) return null;
        const options: { label: string; focused: boolean }[] = [];
        const continuation: string[][] = [];
        for (const line of lines.slice(firstOption, planFooter)) {
            if (!line.trim() || /^\s*shift\+tab to approve with this feedback\s*$/u.test(line)) continue;
            if (line.startsWith('        ') && options.length > 0) {
                continuation[options.length - 1]!.push(line.slice(8));
                continue;
            }
            const row = /^\s*([>›❯])?\s*(\d+)\.\s+(.+)$/u.exec(line);
            if (!row || Number(row[2]) !== options.length + 1) return null;
            options.push({ label: row[3]!.trim(), focused: Boolean(row[1]) });
            continuation.push([]);
        }
        const placeholder = 'Tell Claude what to change';
        for (let index = 0; index < options.length - 1; index += 1) {
            options[index]!.label = [options[index]!.label, ...continuation[index]!].join(' ');
        }
        if (options.length < 2 || options.filter((option) => option.focused).length !== 1
            || !options.slice(0, -1).every((option) => /^Yes\b/u.test(option.label))) return null;
        const feedback = options.at(-1)!;
        const shownText = [feedback.label, ...continuation.at(-1)!].join('\n');
        const feedbackText = shownText === placeholder ? '' : shownText;
        feedback.label = placeholder;
        return {
            kind: 'plan', context: PLAN_QUESTION, options, amended: feedbackText.length > 0,
            feedback: { optionIndex: options.length - 1, placeholder, text: feedbackText },
        };
    }
    const footer = lastLineIndex(lines, /^\s*Esc to cancel(?: · Tab to amend)?\s*$/u);
    if (footer < 0 || lines.slice(footer + 1).some((line) => line.trim())) return null;
    const question = lastLineIndex(lines.slice(0, footer), /^\s*(?:Do you want to .+|Allow .+)\?\s*$/u);
    if (question < 0) return null;
    const options: { label: string; focused: boolean }[] = [];
    for (const line of lines.slice(question + 1, footer)) {
        if (!line.trim()) continue;
        const row = /^\s*([>›❯])?\s*(\d+)\.\s+(.+)$/u.exec(line);
        if (row) {
            if (Number(row[2]) !== options.length + 1) return null;
            options.push({ label: row[3]!.trim(), focused: Boolean(row[1]) });
        } else if (/^\s{6,}\S/u.test(line) && options.length > 0) {
            options[options.length - 1]!.label += ` ${line.trim()}`;
        } else {
            return null;
        }
    }
    if (options.length < 2 || options.filter((option) => option.focused).length !== 1) return null;
    if (new Set(options.map((option) => option.label)).size !== options.length) return null;
    const start = lastLineIndex(lines.slice(0, question), /^\s*[─━]{2,}\s*$/u);
    const context = lines.slice(start + 1, question + 1).map((line) => line.trimEnd()).join('\n').trim();
    const commandEnd = lastLineIndex(lines.slice(start + 1, question), /^\s*╌{2,}\s*$/u);
    const explanation = commandEnd >= 0
        ? lines.slice(start + commandEnd + 2, question + 1).map((line) => line.trimEnd()).join('\n').trim()
        : undefined;
    const readOutside = lines[question]!.trim() === 'Allow this read outside the working directories?'
        && context.split('\n').some((line) => line.trim() === 'Read outside the working directories');
    // Auto-mode read scopes are not ordered as Yes ... No. Recognize the native labels
    // exactly: Tab can amend either approval row, which must remain terminal-owned.
    if (readOutside) {
        if (options.length !== READ_OUTSIDE_CHOICES.length
            || options.some((option, index) => option.label !== READ_OUTSIDE_CHOICES[index])) return null;
    } else if (options[options.length - 1]?.label !== 'No') return null;
    // Remembered/automatic scopes hide the unavailable amendment affordance while focused.
    // The shorter footer needs the observed native tool header as additional provenance.
    if (!lines[footer]!.includes('Tab to amend')
        && (!context.split('\n').some((line) => NATIVE_PERMISSION_HEADER.test(line)) || !/^Yes\b/u.test(options[0]!.label))) return null;
    return {
        kind: 'tool',
        context,
        ...(explanation ? { explanation } : {}),
        options,
        amended: !readOutside && options[0]?.label !== 'Yes',
    };
}
