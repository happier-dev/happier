import { describe, expect, it, vi } from 'vitest';
import { executeCommandPaletteAction, executeCommandPaletteKeyboardCommand, registerCommandPaletteActionCatalog } from './commandPaletteActionRuntime';
import type { Command } from './types';

describe('mounted command palette Actions', () => {
    it('invokes the current plugin contribution for its durable qualified binding id', async () => {
        let invoked = false;
        const release = registerCommandPaletteActionCatalog(() => [{
            id: 'plugin-action:acme.tools/run', actionSpecId: 'acme.tools/run', title: 'Run',
            action: () => { invoked = true; },
        }]);
        try {
            expect(executeCommandPaletteKeyboardCommand('action:acme.tools/actions/run')).toBe('handled');
            await Promise.resolve();
            expect(invoked).toBe(true);
        } finally { release(); }
    });

    it('prepares an unopened Session menu before running its bound operation and withdraws demand afterwards', async () => {
        let demanded = false;
        let invoked = false;
        const release = registerCommandPaletteActionCatalog(() => demanded ? [{
            id: 'session.action:ui.session.rename', title: 'Rename', action: () => { invoked = true; },
        }] : [], async () => {
            demanded = true;
            return () => { demanded = false; };
        });
        try {
            expect(executeCommandPaletteKeyboardCommand('session.action:ui.session.rename')).toBe('handled');
            await vi.waitFor(() => expect(invoked).toBe(true));
            expect(demanded).toBe(false);
        } finally { release(); }
    });
    it('runs the current palette callback for bound Actions including bespoke variants and releases unavailable commands', async () => {
        let invoked = '';
        let commands: readonly Command[] = [{ id: 'voice-mode:0', actionSpecId: 'ui.voice_global.reset', title: 'Reset', action: () => { invoked = 'voice'; } },
            { id: 'session.action:ui.session.rename', title: 'Rename', action: () => { invoked = 'rename'; } }];
        const release = registerCommandPaletteActionCatalog(() => commands);
        try {
            expect(executeCommandPaletteKeyboardCommand('action:ui.voice_global.reset')).toBe('handled');
            await Promise.resolve();
            expect(invoked).toBe('voice');
            expect(executeCommandPaletteKeyboardCommand('session.action:ui.session.rename')).toBe('handled');
            await Promise.resolve();
            expect(invoked).toBe('rename');
            commands = [];
            expect(executeCommandPaletteKeyboardCommand('session.action:ui.session.rename')).toBe('pass');
        } finally { release(); }
    });
    it('does not reclassify commands with an existing Action policy as generic host commands', async () => {
        let invoked = false;
        const release = registerCommandPaletteActionCatalog(() => [{
            id: 'action:ui.voice_global.reset', title: 'Reset voice', actionSpecId: 'ui.voice_global.reset',
            action: () => { invoked = true; },
        }]);
        try {
            await expect(executeCommandPaletteAction({ actionId: 'ui.command_palette.list', input: {}, context: { surface: 'agent' } }))
                .resolves.toEqual({ ok: true, result: { commands: [] } });
            await expect(executeCommandPaletteAction({ actionId: 'ui.command_palette.invoke', input: { commandId: 'action:ui.voice_global.reset' }, context: { surface: 'agent' } }))
                .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
            expect(invoked).toBe(false);
        } finally { release(); }
    });
    it('reads current entries and invokes the latest callback instead of a retained command', async () => {
        let destination = '';
        let commands: readonly Command[] = [{ id: 'account', title: 'Account', action: () => { destination = 'old'; } }];
        const release = registerCommandPaletteActionCatalog(() => commands);
        try {
            await expect(executeCommandPaletteAction({ actionId: 'ui.command_palette.list', input: {}, context: {} }))
                .resolves.toEqual({ ok: true, result: { commands: [{ id: 'account', title: 'Account' }] } });
            commands = [{ id: 'account', title: 'Current account', action: () => { destination = 'current'; } }];
            await expect(executeCommandPaletteAction({ actionId: 'ui.command_palette.invoke', input: { commandId: 'account' }, context: {} }))
                .resolves.toEqual({ ok: true, result: { invoked: true } });
            expect(destination).toBe('current');
            commands = [];
            await expect(executeCommandPaletteAction({ actionId: 'ui.command_palette.invoke', input: { commandId: 'account' }, context: {} }))
                .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
            expect(destination).toBe('current');
        } finally { release(); }
    });

    it('retires mounts without clearing a newer owner and refuses cancelled or unmounted invocation', async () => {
        let invoked = false;
        const oldRelease = registerCommandPaletteActionCatalog(() => []);
        const release = registerCommandPaletteActionCatalog(() => [{ id: 'new-session', title: 'New session', action: () => { invoked = true; } }]);
        oldRelease();
        const cancellation = new AbortController();
        cancellation.abort();
        try {
            await expect(executeCommandPaletteAction({ actionId: 'ui.command_palette.invoke', input: { commandId: 'new-session' }, context: { signal: cancellation.signal } }))
                .resolves.toMatchObject({ ok: false });
            expect(invoked).toBe(false);
            await expect(executeCommandPaletteAction({ actionId: 'ui.command_palette.invoke', input: { commandId: 'new-session' }, context: {} }))
                .resolves.toMatchObject({ ok: true });
            expect(invoked).toBe(true);
        } finally { release(); }
        await expect(executeCommandPaletteAction({ actionId: 'ui.command_palette.list', input: {}, context: {} }))
            .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    });
});
