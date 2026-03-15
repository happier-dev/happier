import { describe, expect, it } from 'vitest';

import { coerceNewSessionModelMode, resolveInitialNewSessionModelMode } from './newSessionModelModePolicy';

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

