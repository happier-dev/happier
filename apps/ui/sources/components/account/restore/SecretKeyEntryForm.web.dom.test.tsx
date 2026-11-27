// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

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

afterEach(() => {
    delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
});

/** jsdom lays nothing out: the key's column reports the width a real layout would give it. */
function layOutKeyColumnAt(widthPx: number) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get(this: HTMLElement) {
            return this.querySelector(':scope > [data-testid="restore-manual-secret-input"]') ? widthPx : 0;
        },
    });
}

// The 32-byte key prints as 11 groups of five (the last one short).
it.each([
    { column: 420, rows: 3, note: 'the signed-out field column: four groups a row' },
    { column: 358, rows: 4, note: 'a 390 phone: three groups a row' },
    { column: 288, rows: 6, note: 'a 320 phone: two groups a row, the cells stay readable' },
])('lays the key out by its measured column ($column px: $note)', async ({ column, rows }) => {
    layOutKeyColumnAt(column);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await act(async () => {
            root.render(<SecretKeyEntryForm submitTitle="Continue" onSubmit={async () => ({ kind: 'completed' })} />);
        });
        const input = container.querySelector<HTMLInputElement>('[data-testid="restore-manual-secret-input"]')!;
        const grid = input.parentElement!.firstElementChild!;
        expect(grid.children.length).toBe(rows);
        expect(Math.max(...[...grid.children].map((row) => row.children.length))).toBeLessThanOrEqual(4);
    } finally {
        await act(async () => { root.unmount(); });
        container.remove();
    }
});
