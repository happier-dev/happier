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

    it('uses provider freeform model id prefixes to reject stale cross-provider remembered selections', () => {
        const out = resolveInitialNewSessionModelMode({
            draftModelMode: 'gpt-5.5',
            modelConfig: {
                defaultMode: 'gemini-2.5-pro',
                allowedModes: ['gemini-2.5-pro'],
                supportsFreeform: true,
                freeformModelIdPrefixes: ['gemini-', 'models/gemini-', 'publishers/google/models/gemini-'],
            },
        });

        expect(out).toBe('gemini-2.5-pro');
    });

    it('keeps constrained provider freeform model ids that match an allowed prefix', () => {
        const out = coerceNewSessionModelMode({
            modelMode: 'models/gemini-3.5-flash',
            modelConfig: {
                defaultMode: 'gemini-2.5-pro',
                allowedModes: ['gemini-2.5-pro'],
                supportsFreeform: true,
                freeformModelIdPrefixes: ['gemini-', 'models/gemini-', 'publishers/google/models/gemini-'],
            },
            preflight: null,
        });

        expect(out).toBe('models/gemini-3.5-flash');
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

    it('falls back to the default sentinel when provider defaultMode is absent', () => {
        const initial = resolveInitialNewSessionModelMode({
            draftModelMode: '   ',
            modelConfig: {
                defaultMode: null,
                allowedModes: [],
                supportsFreeform: false,
                dynamicProbe: 'static-only',
            },
        });
        const coerced = coerceNewSessionModelMode({
            modelMode: null,
            modelConfig: {
                defaultMode: null,
                allowedModes: [],
                supportsFreeform: false,
                dynamicProbe: 'static-only',
            },
            preflight: null,
        });

        expect(initial).toBe('default');
        expect(coerced).toBe('default');
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

    it('coerces stale dynamic/freeform modelMode to default when preflight is unavailable', () => {
        const out = coerceNewSessionModelMode({
            modelMode: 'opencode/big-pickle',
            modelConfig: {
                defaultMode: 'default',
                allowedModes: [],
                supportsFreeform: true,
                dynamicProbe: 'auto',
            },
            preflight: {
                availableModels: [],
                supportsFreeform: false,
                unavailable: true,
            },
        });

        expect(out).toBe('default');
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

    it('repairs stale dynamic display-name selections to the unique provider-qualified preflight id', () => {
        const out = coerceNewSessionModelMode({
            modelMode: 'gpt-5.5',
            modelConfig: {
                defaultMode: 'default',
                allowedModes: [],
                supportsFreeform: true,
                dynamicProbe: 'auto',
            },
            preflight: {
                availableModels: [
                    { id: 'anthropic/claude-sonnet-4-5', name: 'claude-sonnet-4-5' },
                    { id: 'openai-codex/gpt-5.5', name: 'gpt-5.5' },
                ],
                supportsFreeform: true,
            },
        });

        expect(out).toBe('openai-codex/gpt-5.5');
    });

    it('keeps custom/freeform modelMode when display-name repair would be ambiguous', () => {
        const out = coerceNewSessionModelMode({
            modelMode: 'gpt-5.5',
            modelConfig: {
                defaultMode: 'default',
                allowedModes: [],
                supportsFreeform: true,
                dynamicProbe: 'auto',
            },
            preflight: {
                availableModels: [
                    { id: 'provider-a/gpt-5.5', name: 'gpt-5.5' },
                    { id: 'provider-b/gpt-5.5', name: 'gpt-5.5' },
                ],
                supportsFreeform: true,
            },
        });

        expect(out).toBe('gpt-5.5');
    });
});
