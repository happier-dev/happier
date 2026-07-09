import { describe, expect, it } from 'vitest';

import type { AgentId } from '@/agents/catalog/catalog';
import { MACHINE_CLI_MAX_VISIBLE_LOGOS, resolveMachineCliLogoDisplay } from './machineCliLogoDisplay';

const ids = (...names: string[]) => names as unknown as AgentId[];

describe('resolveMachineCliLogoDisplay', () => {
    it('shows every logo when the count is within the cap', () => {
        const result = resolveMachineCliLogoDisplay(ids('claude', 'codex', 'gemini', 'cursor'), 4);
        expect(result.visible).toEqual(ids('claude', 'codex', 'gemini', 'cursor'));
        expect(result.overflow).toBe(0);
    });

    it('reserves the last slot for a "+N" overflow when over the cap (never exceeds the cap)', () => {
        const result = resolveMachineCliLogoDisplay(ids('claude', 'codex', 'gemini', 'cursor', 'qwen', 'kilo'), 4);
        expect(result.visible).toEqual(ids('claude', 'codex', 'gemini'));
        expect(result.overflow).toBe(3);
        expect(result.visible.length + 1).toBe(4);
    });

    it('preserves order and handles empty / single inputs', () => {
        expect(resolveMachineCliLogoDisplay(ids())).toEqual({ visible: ids(), overflow: 0 });
        expect(resolveMachineCliLogoDisplay(ids('claude'))).toEqual({ visible: ids('claude'), overflow: 0 });
    });

    it('defaults to MACHINE_CLI_MAX_VISIBLE_LOGOS', () => {
        const many = Array.from({ length: 11 }, (_unused, index) => `agent-${index}`) as unknown as AgentId[];
        const result = resolveMachineCliLogoDisplay(many);
        expect(result.visible.length).toBe(MACHINE_CLI_MAX_VISIBLE_LOGOS - 1);
        expect(result.overflow).toBe(11 - (MACHINE_CLI_MAX_VISIBLE_LOGOS - 1));
    });
});
