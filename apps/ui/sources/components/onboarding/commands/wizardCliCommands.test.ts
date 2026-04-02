import { describe, expect, it, vi } from 'vitest';

describe('wizardCliCommands', () => {
    it('renders preview lane commands using the hprev shim', async () => {
        vi.resetModules();
        vi.doMock('@/config', () => ({ config: { variant: 'preview' } }));
        const commands = await import('./wizardCliCommands');
        expect(commands.buildAuthLoginCommandForServerUrl('https://api.happier.dev')).toMatch(/^hprev\s/);
        expect(commands.buildHappierSetupCommand({ relayUrl: 'https://api.happier.dev' })).toMatch(/^hprev\s/);
    });

    it('renders dev lane commands using the hdev shim', async () => {
        vi.resetModules();
        vi.doMock('@/config', () => ({ config: { variant: 'publicdev' } }));
        const commands = await import('./wizardCliCommands');
        expect(commands.buildAuthLoginCommandForServerUrl('https://api.happier.dev')).toMatch(/^hdev\s/);
        expect(commands.buildHappierSetupCommand({ relayUrl: 'https://api.happier.dev' })).toMatch(/^hdev\s/);
    });

    it('renders stable lane commands using the happier shim', async () => {
        vi.resetModules();
        vi.doMock('@/config', () => ({ config: { variant: 'production' } }));
        const commands = await import('./wizardCliCommands');
        expect(commands.buildAuthLoginCommandForServerUrl('https://api.happier.dev')).toMatch(/^happier\s/);
        expect(commands.buildHappierSetupCommand({ relayUrl: 'https://api.happier.dev' })).toMatch(/^happier\s/);
    });
});
