import { describe, expect, it } from 'vitest';

import { coerceNewSessionModelMode, resolveInitialNewSessionModelMode } from './newSessionModelModePolicy';
import type { NewSessionModelConfig } from './newSessionModelModePolicy';

describe('newSessionModelModePolicy', () => {
    it('prefers draft modelMode when supportsFreeform is enabled', () => {
        const out = resolveInitialNewSessionModelMode({
            draftModelMode: 'custom-model-id',
            modelConfig: {
                defaultMode: 'gemini-2.5-pro',
                allowedModes: ['gemini-2.5-pro'],
                supportsFreeform: true,
            },
        });

        expect(out).toBe('custom-model-id');
    });

    it('falls back to defaultMode when draft modelMode is empty', () => {
        const out = resolveInitialNewSessionModelMode({
            draftModelMode: '   ',
            modelConfig: {
                defaultMode: 'gemini-2.5-pro',
                allowedModes: ['gemini-2.5-pro'],
                supportsFreeform: true,
            },
        });

        expect(out).toBe('gemini-2.5-pro');
    });

    it('coerces invalid modelMode to defaultMode when freeform is disabled', () => {
        const out = coerceNewSessionModelMode({
            modelMode: 'custom-model-id',
            modelConfig: {
                defaultMode: 'gemini-2.5-pro',
                allowedModes: ['gemini-2.5-pro'],
                supportsFreeform: false,
            },
            preflight: null,
        });

        expect(out).toBe('gemini-2.5-pro');
    });

    it('keeps a dynamic backend model selection while the dynamic model probe has not returned yet', () => {
        const dynamicModelConfig = {
            defaultMode: 'default',
            allowedModes: ['gpt-5.4'],
            supportsFreeform: false,
            dynamicProbe: 'auto',
        } as const satisfies NewSessionModelConfig & { dynamicProbe: 'auto' };

        const out = coerceNewSessionModelMode({
            modelMode: 'gpt-5.5',
            modelConfig: dynamicModelConfig,
            preflight: null,
        });

        expect(out).toBe('gpt-5.5');
    });

    it('prefers draft modelMode for dynamic backends even when the static catalog is stale', () => {
        const out = resolveInitialNewSessionModelMode({
            draftModelMode: 'gpt-5.5',
            modelConfig: {
                defaultMode: 'default',
                allowedModes: ['gpt-5.4'],
                supportsFreeform: false,
                dynamicProbe: 'auto',
            },
        });

        expect(out).toBe('gpt-5.5');
    });

    it('keeps a dynamic backend model selection when the refreshed model list does not include it yet', () => {
        const out = coerceNewSessionModelMode({
            modelMode: 'gpt-5.5',
            modelConfig: {
                defaultMode: 'default',
                allowedModes: ['gpt-5.4'],
                supportsFreeform: false,
                dynamicProbe: 'auto',
            },
            preflight: {
                targetKey: 'agent:codex',
                availableModels: [{ id: 'gpt-5.4' }],
                supportsFreeform: false,
            },
            currentTargetKey: 'agent:codex',
        });

        expect(out).toBe('gpt-5.5');
    });

    it('keeps custom modelMode when freeform is enabled (no preflight)', () => {
        const out = coerceNewSessionModelMode({
            modelMode: 'custom-model-id',
            modelConfig: {
                defaultMode: 'gemini-2.5-pro',
                allowedModes: ['gemini-2.5-pro'],
                supportsFreeform: true,
            },
            preflight: null,
        });

        expect(out).toBe('custom-model-id');
    });

    it('never coerces the special "default" modelMode', () => {
        const out = coerceNewSessionModelMode({
            modelMode: 'default',
            modelConfig: {
                defaultMode: 'gemini-2.5-pro',
                allowedModes: ['gemini-2.5-pro'],
                supportsFreeform: false,
            },
            preflight: null,
        });

        expect(out).toBe('default');
    });

    it('coerces to defaultMode when preflight exists and does not support freeform', () => {
        const out = coerceNewSessionModelMode({
            modelMode: 'custom-model-id',
            modelConfig: {
                defaultMode: 'gemini-2.5-pro',
                allowedModes: ['gemini-2.5-pro'],
                supportsFreeform: true,
            },
            preflight: { availableModels: [{ id: 'm1' }, { id: 'm2' }], supportsFreeform: false },
        });

        expect(out).toBe('gemini-2.5-pro');
    });

    it('ignores preflight results from a different backend target', () => {
        const out = coerceNewSessionModelMode({
            modelMode: 'claude-opus-4-6',
            modelConfig: {
                defaultMode: 'default',
                allowedModes: ['claude-opus-4-6'],
                supportsFreeform: false,
                dynamicProbe: 'static-only',
            },
            preflight: {
                targetKey: 'agent:codex',
                availableModels: [{ id: 'gpt-5.5' }],
                supportsFreeform: false,
            },
            currentTargetKey: 'agent:claude',
        });

        expect(out).toBe('claude-opus-4-6');
    });

    it('keeps custom modelMode when preflight exists and supports freeform', () => {
        const out = coerceNewSessionModelMode({
            modelMode: 'custom-model-id',
            modelConfig: {
                defaultMode: 'gemini-2.5-pro',
                allowedModes: ['gemini-2.5-pro'],
                supportsFreeform: true,
            },
            preflight: { availableModels: [{ id: 'm1' }, { id: 'm2' }], supportsFreeform: true },
        });

        expect(out).toBe('custom-model-id');
    });
});
