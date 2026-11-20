// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { UnauthenticatedStepHeading } from '@/components/onboarding/unauthShell/UnauthenticatedStep';

import { SecretKeyEntryForm } from './SecretKeyEntryForm';
import { t } from '@/text';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => await vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

it('keeps keyboard focus and the invalid draft after Enter submits the real web input', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSubmit = vi.fn(async () => ({ kind: 'completed' as const }));
    try {
        await act(async () => {
            root.render(<SecretKeyEntryForm description="Account key" submitTitle="Continue" onSubmit={onSubmit} />);
        });
        const input = container.querySelector<HTMLInputElement>('[data-testid="restore-manual-secret-input"]')!;
        const draft = 'malformed not-a-key';
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, draft);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
        });
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            await vi.runOnlyPendingTimersAsync();
        });
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(t('connect.invalidSecretKey'));
        expect(input.value).toBe(draft);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(input);
    } finally {
        await act(async () => { root.unmount(); });
        container.remove();
        vi.useRealTimers();
    }
});

it('gives the key an accessible name that the step heading shows (the cells draw no label of their own)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await act(async () => {
            root.render(
                <>
                    <UnauthenticatedStepHeading title={t('setupOnboarding.authSecretKeyTitle')} />
                    <SecretKeyEntryForm
                        submitTitle="Continue"
                        onSubmit={async () => ({ kind: 'completed' })}
                    />
                </>,
            );
        });

        const input = container.querySelector<HTMLInputElement>('[data-testid="restore-manual-secret-input"]')!;
        const accessibleName = input.getAttribute('aria-label');
        expect(accessibleName).toBeTruthy();
        expect(container.textContent?.toLowerCase()).toContain(accessibleName!.toLowerCase());
    } finally {
        await act(async () => { root.unmount(); });
        container.remove();
    }
});

it('uses a password input with autocomplete disabled until the user explicitly reveals the key', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await act(async () => {
            root.render(
                <SecretKeyEntryForm description="Account key" submitTitle="Continue"
                    onSubmit={async () => ({ kind: 'completed' })} />,
            );
        });
        const input = container.querySelector<HTMLInputElement>('[data-testid="restore-manual-secret-input"]')!;
        const syntheticKey = 'synthetic-recovery-key-for-secure-entry';
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, syntheticKey);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        // Showing the key is offered once there is a key to show.
        const reveal = container.querySelector<HTMLElement>('[data-testid="restore-manual-secret-reveal"]')!;

        expect(input.tagName).toBe('INPUT');
        expect(input.type).toBe('password');
        expect(input.autocomplete).toBe('off');
        expect(container.textContent).not.toContain(syntheticKey);
        expect(input.getAttribute('aria-valuetext')).toBeNull();
        expect(input.getAttribute('aria-label')).toBe(t('connect.secretKeyInputLabel'));

        await act(async () => { reveal.click(); });
        expect(input.type).toBe('text');
        expect(input.value).toBe(syntheticKey);
        expect(input.autocomplete).toBe('off');

        await act(async () => { reveal.click(); });
        expect(input.type).toBe('password');
        expect(input.value).toBe(syntheticKey);
        expect(input.autocomplete).toBe('off');
    } finally {
        await act(async () => { root.unmount(); });
        container.remove();
    }
});
