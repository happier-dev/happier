import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { AssignableSessionRole } from '@happier-dev/protocol';

// Native rendering is the boundary; the editor, copy and footer actions remain real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/components/ui/forms/color/ThemeColorPicker', () => ({ ThemeColorPicker: 'ThemeColorPicker' }));

async function renderEditor(props: Readonly<{ instructions: string; isCustom: boolean; role?: AssignableSessionRole; name?: string; displayName?: string | null; color?: string | null; customProfile?: boolean }>) {
    const { SessionRoleProfileEditorModal } = await import('./SessionRoleProfileEditorModal');
    const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
    const onResolve = vi.fn();
    const onClose = vi.fn();
    let chrome: { footer?: React.ReactNode; title?: string } | null = null;
    const setChrome = vi.fn((next: typeof chrome) => { chrome = next; });
    const screen = await renderScreen(
        <SessionRoleProfileEditorModal {...props} role={props.role ?? 'reviewer'} onResolve={onResolve} onClose={onClose} setChrome={setChrome as never} />,
    );
    // The card chrome footer is re-published whenever editor state changes; render the latest one.
    const button = async (title: string) => {
        const footer = await renderScreen(<>{(chrome as { footer?: React.ReactNode } | null)?.footer}</>);
        return footer.findAllByType(RoundButton).find((node) => node.props.title === title);
    };
    return { screen, button, onResolve, onClose, title: () => (chrome as { title?: string } | null)?.title };
}

describe('SessionRoleProfileEditorModal', () => {
    it('uses session-role copy without overstating changes to retained session snapshots', async () => {
        const { en } = await import('@/text/translations/en');
        expect(en.sessionRole.profiles.groupTitle).toBe('Session roles');
        expect(en.sessionRole.profiles.editorTitle({ role: 'Worker' })).toBe('Edit Worker role');
        expect(en.sessionRole.profiles.footer).toBe(
            'Instruction edits apply on assignment or explicit reapply; existing sessions retain their instructions.',
        );
        expect(en.sessionRole.profiles.editorHint).toContain('Badge colors apply to every session with this role.');
        expect(en.sessionRole.profiles.editorHintCustom).toContain('Badge colors apply to new assignments');
    });

    it('describes built-in and custom role color scope accurately', async () => {
        const { t } = await import('@/text');
        const builtIn = await renderEditor({
            role: 'reviewer',
            instructions: 'Review.',
            isCustom: false,
        });
        expect(builtIn.screen.findByTestId('session-role-profile-editor-hint')?.props.children)
            .toBe(t('sessionRole.profiles.editorHint'));

        const custom = await renderEditor({
            role: 'custom:123e4567-e89b-12d3-a456-426614174000',
            name: 'Architect',
            color: '#123456',
            instructions: 'Design.',
            isCustom: true,
            customProfile: true,
        });
        expect(custom.screen.findByTestId('session-role-profile-editor-hint')?.props.children)
            .toBe(t('sessionRole.profiles.editorHintCustom'));
    });

    it('edits instructions in a labelled field and saves them', async () => {
        const { t } = await import('@/text');
        const editor = await renderEditor({ instructions: 'Current rules.', isCustom: true });
        const input = editor.screen.findByTestId('session-role-profile-instructions');
        expect(input?.props.accessibilityLabel).toBe(t('sessionRole.profiles.editorTitle', { role: t('sessionRole.reviewer') }));
        expect(editor.title()).toBe(t('sessionRole.profiles.editorTitle', { role: t('sessionRole.reviewer') }));
        await React.act(async () => { input?.props.onChangeText('Edited rules.'); });
        const save = await editor.button(t('common.save'));
        await React.act(async () => { save?.props.onPress(); });
        expect(editor.onResolve).toHaveBeenCalledWith({ kind: 'save', instructions: 'Edited rules.' });
        expect(editor.onClose).toHaveBeenCalledOnce();

        await React.act(async () => { input?.props.onChangeText('   '); });
        expect((await editor.button(t('common.save')))?.props.disabled).toBe(true);
    });

    it('edits a built-in display alias without changing the prompt-facing role name', async () => {
        const { t } = await import('@/text');
        const editor = await renderEditor({
            role: 'reviewer',
            displayName: 'Quality Gate',
            instructions: 'Review.',
            isCustom: true,
        });
        const displayName = editor.screen.findByTestId('session-role-profile-display-name');
        expect(displayName?.props.accessibilityLabel).toBe(t('sessionRole.profiles.displayNameLabel'));
        await React.act(async () => { displayName?.props.onChangeText('Final Review'); });
        const save = await editor.button(t('common.save'));
        await React.act(async () => { save?.props.onPress(); });
        expect(editor.onResolve).toHaveBeenCalledWith({
            kind: 'save',
            displayName: 'Final Review',
            instructions: 'Review.',
        });
    });

    it('resets a customized profile and disables reset for the untouched default', async () => {
        const { t } = await import('@/text');
        const { DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1 } = await import('@happier-dev/protocol');
        const custom = await renderEditor({ instructions: 'Custom.', displayName: 'Alias', isCustom: true });
        const reset = await custom.button(t('sessionRole.profiles.resetToDefault'));
        await React.act(async () => { reset?.props.onPress(); });
        expect(custom.onResolve).toHaveBeenCalledWith({ kind: 'reset' });

        const untouched = await renderEditor({ instructions: DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.reviewer, isCustom: false });
        expect((await untouched.button(t('sessionRole.profiles.resetToDefault')))?.props.disabled).toBe(true);
        const cancel = await untouched.button(t('common.cancel'));
        await React.act(async () => { cancel?.props.onPress(); });
        expect(untouched.onResolve).toHaveBeenCalledWith(null);
    });

    it('edits a custom role name, prompt, and color and exposes removal', async () => {
        const { t } = await import('@/text');
        const { ThemeColorPicker } = await import('@/components/ui/forms/color/ThemeColorPicker');
        const editor = await renderEditor({
            role: 'custom:123e4567-e89b-12d3-a456-426614174000',
            name: 'Architect',
            color: '#123456',
            instructions: 'Design.',
            isCustom: true,
            customProfile: true,
        });
        const name = editor.screen.findByTestId('session-role-profile-name');
        expect(name?.props.accessibilityLabel).toBe(t('sessionRole.profiles.nameLabel'));
        await React.act(async () => { name?.props.onChangeText('System Architect'); });
        await React.act(async () => { editor.screen.findByTestId('session-role-profile-instructions')?.props.onChangeText('Design safely.'); });
        const picker = editor.screen.findAllByType(ThemeColorPicker as never)[0];
        await React.act(async () => { picker?.props.onChange('#abcdef'); });
        const save = await editor.button(t('common.save'));
        await React.act(async () => { save?.props.onPress(); });
        expect(editor.onResolve).toHaveBeenCalledWith({
            kind: 'save',
            name: 'System Architect',
            instructions: 'Design safely.',
            color: '#abcdef',
        });
        const removal = await renderEditor({
            role: 'custom:123e4567-e89b-12d3-a456-426614174000',
            name: 'Architect',
            color: '#123456',
            instructions: 'Design.',
            isCustom: true,
            customProfile: true,
        });
        const remove = await removal.button(t('common.delete'));
        await React.act(async () => { remove?.props.onPress(); });
        expect(removal.onResolve).toHaveBeenCalledWith({ kind: 'delete' });
    });
});
