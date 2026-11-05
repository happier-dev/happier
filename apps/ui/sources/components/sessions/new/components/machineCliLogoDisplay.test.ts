import { describe, expect, it } from 'vitest';

import { MACHINE_CLI_MAX_VISIBLE_LOGOS, resolveMachineCliLogoDisplay } from './machineCliLogoDisplay';

const agents = (...names: string[]) => names.map((agentId) => ({ agentId }));
const logos = (...names: string[]) => names.map((agentId) => ({ id: agentId, agentId }));

describe('resolveMachineCliLogoDisplay', () => {
    it('shows every logo when the count is within the cap', () => {
        const result = resolveMachineCliLogoDisplay(agents('claude', 'codex', 'gemini', 'cursor'), 4);
        expect(result.visible).toEqual(logos('claude', 'codex', 'gemini', 'cursor'));
        expect(result.overflow).toBe(0);
    });

    it('reserves the last slot for a "+N" overflow when over the cap (never exceeds the cap)', () => {
        const result = resolveMachineCliLogoDisplay(agents('claude', 'codex', 'gemini', 'cursor', 'qwen', 'kilo'), 4);
        expect(result.visible).toEqual(logos('claude', 'codex', 'gemini'));
        expect(result.overflow).toBe(3);
        expect(result.visible.length + 1).toBe(4);
    });

    it('preserves order and handles empty / single inputs', () => {
        expect(resolveMachineCliLogoDisplay(agents())).toEqual({ visible: logos(), overflow: 0 });
        expect(resolveMachineCliLogoDisplay(agents('claude'))).toEqual({ visible: logos('claude'), overflow: 0 });
    });

    it('defaults to MACHINE_CLI_MAX_VISIBLE_LOGOS', () => {
        const many = Array.from({ length: 11 }, (_unused, index) => ({ agentId: `agent-${index}` }));
        const result = resolveMachineCliLogoDisplay(many);
        expect(result.visible.length).toBe(MACHINE_CLI_MAX_VISIBLE_LOGOS - 1);
        expect(result.overflow).toBe(11 - (MACHINE_CLI_MAX_VISIBLE_LOGOS - 1));
    });
});
