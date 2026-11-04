import { describe, expect, it } from 'vitest';

import { createCaptureDisclosureState, reduceCaptureDisclosure } from '../disclosure/captureDisclosureRule';
import { t } from '@/text';

import { resolveCaptureWindowTextView } from './captureWindowTextView';

const source = { appName: 'Safari', windowTitle: 'Checkout', windowId: 1 };
const ready = { status: 'settled', result: { status: 'ready', text: 'one two three', source } } as const;
const view = (disclosure: ReturnType<typeof createCaptureDisclosureState>, read: Parameters<typeof resolveCaptureWindowTextView>[0]['read'] = { status: 'idle' }) =>
    resolveCaptureWindowTextView({ disclosure, read, appName: 'Safari' });
const blurred = reduceCaptureDisclosure(createCaptureDisclosureState(true), { type: 'document', blurCount: 1, cause: 'edit' });

describe('resolveCaptureWindowTextView', () => {
    it('offers View only for text the person can read before it goes', () => {
        expect(view(createCaptureDisclosureState(true), ready)).toMatchObject({ chip: 'on', preview: { text: 'one two three', wordCount: '3' } });
        expect(view(createCaptureDisclosureState(true), { status: 'loading' })).toMatchObject({ chip: 'reading', preview: null });
        expect(view(createCaptureDisclosureState(true), { status: 'settled', result: { status: 'empty', source } })).toMatchObject({ chip: 'empty', preview: null });
        expect(view(createCaptureDisclosureState(true), { status: 'failed', errorCode: 'native_failure' })).toMatchObject({ chip: 'unavailable', preview: null });
    });

    it('never previews text the rule turned off, even though a read already holds it', () => {
        expect(view(blurred, ready)).toMatchObject({ chip: 'locked', preview: null, ask: 'blurred' });
    });

    it('asks once for each cause and keeps the chip honest while it asks', () => {
        const pending = reduceCaptureDisclosure(reduceCaptureDisclosure(blurred, { type: 'input' }), { type: 'toggle', included: true });
        expect(view(pending, ready)).toMatchObject({ chip: 'off', ask: 'includeBlurred' });
        expect(view(createCaptureDisclosureState(true), { status: 'settled', result: { status: 'unavailable', reason: 'permission_required', source } }))
            .toMatchObject({ chip: 'off', ask: 'permission', preview: null });
    });

    it('names the frontmost window as the source when the text was read before the system picker (Wayland)', () => {
        const frontmost = { status: 'settled', result: { status: 'ready', text: 'one two three', source, scope: 'whole_frontmost_window' } } as const;
        expect(view(createCaptureDisclosureState(true), frontmost).label)
            .toBe(t('screenCapture.windowText.frontmostLabel', { app: 'Safari', count: '3' }));
        expect(view(createCaptureDisclosureState(true), ready).label).toBe(t('screenCapture.windowText.label', { app: 'Safari', count: '3' }));
    });

    it('turns amber only after the person chose to include what they blurred', () => {
        const pending = reduceCaptureDisclosure(blurred, { type: 'toggle', included: true });
        const included = reduceCaptureDisclosure(pending, { type: 'warning', include: true });
        expect(view(included, ready)).toMatchObject({ chip: 'amber', ask: 'none' });
    });
});
