import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseClaudeNativePermissionScreen } from './nativePermissionScreen';

// Claude Code 2.1.304, real Haiku/low probe. The native remembered rule is broader than
// permission_suggestions in the hook, so the UI must preserve these exact visible choices.
const SCREEN = [
    ' Bash command',
    ' Write probe text',
    '╌╌╌╌╌╌╌',
    ' │ python3 -c "print(671)"',
    '╌╌╌╌╌╌╌',
    ' This command requires approval',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don’t ask again for: python3 *',
    '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
    '   4. No',
    '',
    ' Esc to cancel · Tab to amend',
].join('\n');

describe('native Claude permission presentation', () => {
    it('separates Claude’s permission explanation from a clipped command block without dropping its visible identity', () => {
        const explanation = "A variable in this command can't be checked before it runs\n Permission rule Bash(cat *) requires confirmation for this command.\n /permissions to update rules\n\n Do you want to proceed?";
        const screen = ` │ synthetic command tail\n╌╌╌╌╌╌╌\n ${explanation}\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend`;
        expect(parseClaudeNativePermissionScreen(screen)).toMatchObject({
            context: expect.stringContaining('synthetic command tail'), explanation,
            options: [{ label: 'Yes', focused: true }, { label: 'No', focused: false }],
            amended: false,
        });
    });
    it.each([
        ['claude-2.1.310-read-outside.txt', 0],
        ['claude-2.1.310-read-outside-narrow.txt', 3],
    ] as const)('preserves every native read-outside-directory scope, including wrapped labels (%s)', (fixture, focused) => {
        const screen = readFileSync(new URL(`./__fixtures__/${fixture}`, import.meta.url), 'utf8');
        const labels = [
            'Yes, and keep allowing any reads outside the working directories',
            'No, and block reads outside the working directories from now on',
            'No, and ask again next time',
            'Yes, but ask again next time',
        ];
        expect(parseClaudeNativePermissionScreen(screen)).toMatchObject({
            kind: 'tool', amended: false,
            options: labels.map((label, index) => ({ label, focused: index === focused })),
        });
        // Persistent scopes hide the amendment hint; they remain the same native form.
        const blockFocused = screen.replace(/^ ❯ (\d+)\./mu, '   $1.')
            .replace(/^   2\./mu, ' ❯ 2.').replace(' · Tab to amend', '');
        expect(parseClaudeNativePermissionScreen(blockFocused)).toMatchObject({
            kind: 'tool', amended: false, options: labels.map((label, index) => ({ label, focused: index === 1 })),
        });
    });
    it('preserves an ordinary native Read file scope while focus hides the amendment hint', () => {
        const screen = readFileSync(new URL('./__fixtures__/claude-2.1.310-read-focused.txt', import.meta.url), 'utf8');
        expect(parseClaudeNativePermissionScreen(screen)).toMatchObject({
            kind: 'tool', amended: false,
            options: [
                { label: 'Yes', focused: false },
                { label: 'Yes, allow reading from /tmp/issue671-native-probe/workspace during this session', focused: true },
                { label: 'No', focused: false },
            ],
        });
    });
    it('keeps read-outside-directory amendments, unknown scopes and incomplete forms out of remote approval', () => {
        const screen = readFileSync(new URL('./__fixtures__/claude-2.1.310-read-outside.txt', import.meta.url), 'utf8');
        expect(parseClaudeNativePermissionScreen(screen.replace('4. Yes, but ask again next time',
            '4. Yes, but ask again next time, Use only the synthetic fixture.'))).toBeNull();
        expect(parseClaudeNativePermissionScreen(screen.replace('2. No, and block reads outside the working directories from now on',
            '2. No, and change an unknown policy'))).toBeNull();
        expect(parseClaudeNativePermissionScreen(screen.replace(/^.*4\. Yes.+\n/mu, ''))).toBeNull();
        expect(parseClaudeNativePermissionScreen(screen.replace(' Read outside the working directories\n', ' Upgrade notice\n'))).toBeNull();
        expect(parseClaudeNativePermissionScreen(screen + 'Unknown active dialog')).toBeNull();
    });
    it('recognizes native permission and plan forms above the observed session-title rule while keeping unknown tails blocked', () => {
        const title = '\n──────────────────────────────────────────────────── test-plan-approval-prompt ─';
        expect(parseClaudeNativePermissionScreen(SCREEN + title)?.kind).toBe('tool');
        const plan = readFileSync(new URL('./__fixtures__/claude-2.1.309-plan-wrapped.txt', import.meta.url), 'utf8');
        expect(parseClaudeNativePermissionScreen(plan + title)?.kind).toBe('plan');
        expect(parseClaudeNativePermissionScreen(`${SCREEN}${title}\nUnknown active dialog`)).toBeNull();
    });
    it('retains complete native plan scopes when the question, choice and editor footer wrap at the live pane width', () => {
        const screen = readFileSync(new URL('./__fixtures__/claude-2.1.309-plan-wrapped.txt', import.meta.url), 'utf8');
        expect(parseClaudeNativePermissionScreen(screen)).toMatchObject({
            kind: 'plan', context: 'Claude has written up a plan and is ready to execute. Would you like to proceed?',
            options: [
                { label: 'Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session', focused: true },
                { label: 'Yes, manually approve edits', focused: false },
                { label: 'Tell Claude what to change', focused: false },
            ],
            feedback: { optionIndex: 2, text: '' }, amended: false,
        });
    });
    it('preserves the same native permission while remembered-scope focus temporarily hides the amendment hint', () => {
        const screen = readFileSync(new URL('./__fixtures__/claude-2.1.309-permission-remember-focused.txt', import.meta.url), 'utf8');
        const parsed = parseClaudeNativePermissionScreen(screen);
        expect(parsed?.options[1]).toEqual({ label: 'Yes, and don’t ask again for: ruby *', focused: true });
        expect(parsed?.options.at(-1)?.label).toBe('No');
        expect(parseClaudeNativePermissionScreen(screen.replace(' Bash command\n', ' Upgrade notice\n'))).toBeNull();
    });
    it('recognizes native ExitPlanMode choices and its editable feedback row without copying plan content', () => {
        const screen = readFileSync(new URL('./__fixtures__/claude-2.1.304-plan-exit.txt', import.meta.url), 'utf8');
        expect(parseClaudeNativePermissionScreen(screen)).toMatchObject({
            kind: 'plan',
            context: 'Claude has written up a plan and is ready to execute. Would you like to proceed?',
            options: [
                { label: 'Yes, and use auto mode', focused: true },
                { label: 'Yes, manually approve edits', focused: false },
                { label: 'Tell Claude what to change', focused: false },
            ],
            feedback: { optionIndex: 2, placeholder: 'Tell Claude what to change', text: '' },
            amended: false,
        });
    });
    it('keeps native plan feedback separate from its stable choice labels', () => {
        const screen = readFileSync(new URL('./__fixtures__/claude-2.1.304-plan-feedback.txt', import.meta.url), 'utf8');
        expect(parseClaudeNativePermissionScreen(screen)).toMatchObject({ kind: 'plan', amended: true,
            feedback: { optionIndex: 2, placeholder: 'Tell Claude what to change', text: 'Keep this harmless probe; do not execute the plan.' },
        });
        expect(parseClaudeNativePermissionScreen(screen)?.options[2]).toEqual({ label: 'Tell Claude what to change', focused: true });
    });
    it('retains the actual native approval scopes and command context', () => {
        expect(parseClaudeNativePermissionScreen(SCREEN)).toMatchObject({
            context: expect.stringContaining('python3 -c "print(671)"'),
            options: [
                { label: 'Yes', focused: true },
                { label: 'Yes, and don’t ask again for: python3 *', focused: false },
                { label: 'Yes, and switch to auto mode · auto mode handles these prompts for you', focused: false },
                { label: 'No', focused: false },
            ],
            amended: false,
        });
    });

    it('does not treat a numbered question or historical permission text as a live permission', () => {
        expect(parseClaudeNativePermissionScreen(SCREEN.replace('Esc to cancel · Tab to amend', '❯ Next task'))).toBeNull();
        expect(parseClaudeNativePermissionScreen(SCREEN.replace('Do you want to proceed?', 'Which color?'))).toBeNull();
    });

    it('exposes a terminal amendment so remote approval cannot silently replace it', () => {
        expect(parseClaudeNativePermissionScreen(SCREEN.replace('1. Yes\n', '1. Yes, probe clarification only\n'))?.amended).toBe(true);
    });

    it('preserves wrapped native file-permission choices', () => {
        const write = [
            '──────────────────', ' Create file', ' native-write-probe.txt',
            '  1 native write probe', ' Do you want to create native-write-probe.txt?',
            ' ❯ 1. Yes',
            '   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session',
            '      (shift+tab)', '   3. No', '', ' Esc to cancel · Tab to amend',
        ].join('\n');
        expect(parseClaudeNativePermissionScreen(write)?.options[1]?.label).toBe(
            'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
        );
    });
});
