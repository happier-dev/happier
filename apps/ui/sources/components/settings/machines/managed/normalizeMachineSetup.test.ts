import { afterEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
afterEach(() => standardCleanup());
const { normalizeMachineSetup } = await import('./MachineSetupSection');

describe('ordered setup draft preservation', () => {
    it('preserves every script and metadata verbatim while normalizing an unrelated part', () => {
        const scripts = [
            { body: '\r\necho first\r\n', affects: 'none' as const },
            { body: ' \r\n', check: { executable: 'test', args: ['-f', '/ready'], unsatisfiedExitCodes: [1] } },
            { body: '', affects: { services: ['editor'] } },
        ];
        // This structural input is accepted by the current type because toolchain
        // already belongs to MachineSetupV1; it exposes today's lossy projector
        // without weakening the canonical type before the ordered-list producer.
        const setup = { toolchain: { adapterId: 'mise', config: '[tools]\n' }, scripts,
            secretRefs: { v: 1 as const, bindings: {} } };
        const normalized = normalizeMachineSetup(setup);
        expect(normalized).toEqual({ toolchain: setup.toolchain, scripts });
        expect(normalized && Reflect.get(normalized, 'scripts')).toBe(scripts);
        expect(normalized).not.toHaveProperty('setupScript');
    });

    it('preserves explicit empty script lists and drops only genuinely empty setup', () => {
        const setup = { items: [], scripts: [] };
        expect(normalizeMachineSetup(setup)).toEqual(setup);
        expect(normalizeMachineSetup({})).toBeUndefined();
    });
});
