import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { hasTranslation, setPreferredLanguageFromSettings, tLoose } from '@/text';

import { PersonalHomeSetupSurface } from './PersonalHomeSetupSurface';
import { derivePersonalHomeSetupProgress } from './personalHomeSetupProgress';
import { sanitizePersonalHomeDiagnosticMessage } from './PersonalHomeDiagnosticDetails';
import type { PersonalHomeBootstrapSnapshot } from '../bootstrap/personalHomeBootstrapTypes';
import type { SystemTaskRunState } from '@/components/systemTasks/types';

const transparency = vi.hoisted(() => ({ reduced: false }));

vi.mock('react-native', async () => {
    // Import the boundary factory directly: the barrel's render helpers also import react-native.
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        AccessibilityInfo: {
            isReduceTransparencyEnabled: async () => transparency.reduced,
        },
    });
});

const snapshot: PersonalHomeBootstrapSnapshot = {
    shouldGateShell: true,
    homeReady: false,
    daemonReady: false,
    phase: 'ensuring-home',
    daemonState: 'not-started',
    action: 'none',
};

describe('PersonalHomeSetupSurface', () => {
    it('names acquisition failure from the task when bootstrap uses a generic operation failure', async () => {
        const screen = await renderScreen(<PersonalHomeSetupSurface
            snapshot={{ ...snapshot, phase: 'blocked', action: 'retry', detail: {
                code: 'bootstrap_operation_failed', message: 'diagnostic URL', retryable: true,
            } }}
            activeTask={{ taskId: 'acquire', status: 'failed', currentStepId: null, latestMessage: null,
                awaitingInput: false, cancelRequested: false, events: [], result: {
                    protocolVersion: 1, taskId: 'acquire', ok: false,
                    error: { code: 'cli_acquisition_verifying_failed', message: 'diagnostic URL' },
                } }}
        />);
        expect(screen.findByTestId('personal-home-bootstrap-phase')?.props.children)
            .toBe(tLoose('cliAcquisitionProgress.acquisitionVerificationFailed'));
        expect(screen.getTextContent()).not.toContain('diagnostic URL');
    });

    it('shows acquisition bytes without advancing readiness milestones, and clears them after completion', async () => {
        const activeTask: SystemTaskRunState = {
            taskId: 'acquire', status: 'running', currentStepId: 'setup.thisComputer.ensureCli',
            latestMessage: null, awaitingInput: false, cancelRequested: false, result: null,
            events: [{ protocolVersion: 1, taskId: 'acquire', tsMs: 1, type: 'cli.acquisition.progress',
                data: { phase: 'downloading', receivedBytes: 1024, totalBytes: 2048 } }],
        };
        const screen = await renderScreen(<PersonalHomeSetupSurface snapshot={snapshot} activeTask={activeTask} />);
        expect(screen.findByTestId('personal-home-bootstrap-download-progress')).not.toBeNull();
        expect(screen.getTextContent()).toContain('1.0 KB');
        expect(screen.getTextContent()).toContain('2.0 KB');
        expect(screen.findByTestId('personal-home-bootstrap-progress')).toBeNull();
        await screen.update(<PersonalHomeSetupSurface snapshot={snapshot} activeTask={{
            ...activeTask, status: 'succeeded', result: { protocolVersion: 1, taskId: 'acquire', ok: true },
        }} />);
        expect(screen.findByTestId('personal-home-bootstrap-download-progress')).toBeNull();
    });

    it('redacts explicit secrets without hiding ordinary custody and credential failure prose', () => {
        expect(sanitizePersonalHomeDiagnosticMessage('seed custody is unavailable')).toBe('seed custody is unavailable');
        expect(sanitizePersonalHomeDiagnosticMessage('credential persistence failed')).toBe('credential persistence failed');
        expect(sanitizePersonalHomeDiagnosticMessage('seed=abcdef0123456789abcdef0123456789')).toBe('seed=[redacted]');
        expect(sanitizePersonalHomeDiagnosticMessage('authorization=opaque-value')).toBe('authorization=[redacted]');
        expect(sanitizePersonalHomeDiagnosticMessage('Authorization: Bearer top-secret-token')).toBe('Authorization: Bearer [redacted]');
    });

    it('resolves every setup label through the canonical translation catalog', () => {
        const keys = [
            'title',
            'ensuringHomeStatus',
            'preparingComputerStatus',
            'blockedStatus',
            'readyStatus',
            'failureBody',
            'profileRecoveryBody',
            'computerRecoveryBody',
            'existingRuntimeBody',
            'useExisting',
            'useExistingDetail',
            'useAnother',
            'useAnotherDetail',
        ];

        for (const key of keys) {
            expect(hasTranslation(`personalHome.bootstrap.${key}`)).toBe(true);
        }

        setPreferredLanguageFromSettings('de');
        try {
            expect(tLoose('personalHome.bootstrap.title')).not.toBe('personalHome.bootstrap.title');
        } finally {
            setPreferredLanguageFromSettings(null);
        }
    });

    it('renders one stable operational frame with one live status and one activity treatment', async () => {
        const screen = await renderScreen(<PersonalHomeSetupSurface snapshot={snapshot} />);
        expect(screen.findByTestId('personal-home-setup-surface')).not.toBeNull();
        expect(screen.findByTestId('personal-home-bootstrap-phase')).not.toBeNull();
        expect(screen.findAllHostsByTestId('personal-home-bootstrap-activity')).toHaveLength(1);
        expect(screen.findByTestId('personal-home-bootstrap-progress')).toBeNull();
    });

    it('names the Personal Home while checking instead of showing a generic loading label', async () => {
        const screen = await renderScreen(<PersonalHomeSetupSurface snapshot={{ ...snapshot, phase: 'checking' }} />);
        const text = screen.getTextContent();

        expect(text).toContain(tLoose('personalHome.bootstrap.checkingStatus'));
        expect(text).not.toContain(tLoose('common.loading'));
    });

    it('exposes retry/details for failure without a competing progress checklist', async () => {
        const failed: PersonalHomeBootstrapSnapshot = {
            ...snapshot,
            phase: 'blocked',
            action: 'retry',
            detail: { code: 'auth', message: 'Needs attention', retryable: true },
        };
        const screen = await renderScreen(
            <PersonalHomeSetupSurface snapshot={failed} onRetry={() => {}} onOpenDetails={() => {}} />,
        );
        expect(screen.findByTestId('personal-home-bootstrap-retry')).not.toBeNull();
        expect(screen.findByTestId('personal-home-bootstrap-details')).not.toBeNull();
        expect(screen.findByTestId('personal-home-bootstrap-activity')).toBeNull();
    });

    // U10: a failure Retry cannot fix (offline runtime install, unhealthy runtime) must not trap the
    // user behind the full-screen gate: "Use another Home" stays available when setup is blocked.
    it('keeps "Use another Home" available when the gate is blocked', async () => {
        const screen = await renderScreen(<PersonalHomeSetupSurface
            snapshot={{ ...snapshot, phase: 'blocked', action: 'retry', detail: {
                code: 'runtime_unhealthy', message: 'runtime unhealthy', retryable: true,
            } }}
            onRetry={() => {}}
            onUseAnotherHome={() => {}}
        />);
        expect(screen.findByTestId('personal-home-bootstrap-retry')).not.toBeNull();
        expect(screen.findByTestId('personal-home-use-another')).not.toBeNull();
    });

    // R10 D4: one question, two answers, no failure framing and no competing escape.
    it('asks a signed-in user to keep their Home or set up a Personal Home', async () => {
        const screen = await renderScreen(<PersonalHomeSetupSurface
            snapshot={{ ...snapshot, phase: 'blocked', action: 'choose-signed-in-home', signedInHomeLabel: 'Happier Cloud', detail: {
                code: 'signed_in_other_home', message: 'signed in elsewhere', retryable: false,
            } }}
            onKeepSignedInHome={() => {}}
            onCreatePersonalHome={() => {}}
            onUseAnotherHome={() => {}}
        />);
        expect(screen.findByTestId('personal-home-keep-signed-in-home')).not.toBeNull();
        expect(screen.findByTestId('personal-home-create-personal-home')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Happier Cloud');
        expect(screen.findByTestId('personal-home-bootstrap-failure')).toBeNull();
        expect(screen.findByTestId('personal-home-use-another')).toBeNull();
    });

    it('discloses sanitized failure details without an active task or external callback', async () => {
        const failed: PersonalHomeBootstrapSnapshot = {
            ...snapshot,
            phase: 'blocked',
            action: 'retry',
            detail: {
                code: 'credential_write_failed',
                message: 'Authorization: Bearer top-secret-token; seed=abcdef0123456789abcdef0123456789',
                retryable: true,
            },
        };
        const screen = await renderScreen(<PersonalHomeSetupSurface snapshot={failed} onRetry={() => {}} />);

        expect(screen.findByTestId('personal-home-bootstrap-details')).not.toBeNull();
        await screen.pressByTestIdAsync('personal-home-bootstrap-details');
        expect(screen.findByTestId('personal-home-bootstrap-details-panel')).not.toBeNull();
        expect(screen.findAllHostsByTestId('personal-home-diagnostic-code')).toHaveLength(1);
        expect(screen.root.findAll((node) => typeof node.props.children === 'string' && node.props.children.includes('top-secret-token'))).toHaveLength(0);
        expect(screen.root.findAll((node) => typeof node.props.children === 'string' && node.props.children.includes('abcdef0123456789abcdef0123456789'))).toHaveLength(0);
    });

    it('exposes exactly one working details action for a failed active task', async () => {
        const failed: PersonalHomeBootstrapSnapshot = {
            ...snapshot,
            phase: 'blocked',
            action: 'retry',
            detail: { code: 'auth', message: 'Technical detail shown only in diagnostics', retryable: true },
        };
        const screen = await renderScreen(
            <PersonalHomeSetupSurface
                snapshot={failed}
                activeTask={{
                    status: 'running',
                    taskId: 'personal-home-test',
                    currentStepId: null,
                    latestMessage: null,
                    awaitingInput: false,
                    cancelRequested: false,
                    events: [],
                    result: null,
                }}
                onRetry={() => {}}
            />,
        );

        expect(screen.findAllHostsByTestId('personal-home-bootstrap-details')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('personal-home-bootstrap-details-toggle')).toHaveLength(0);
        await screen.pressByTestIdAsync('personal-home-bootstrap-details');
        expect(screen.findByTestId('personal-home-bootstrap-details-panel')).not.toBeNull();
    });

    it('shows the existing-Home choice without a competing generic failure surface', async () => {
        const needsChoice: PersonalHomeBootstrapSnapshot = {
            ...snapshot,
            phase: 'blocked',
            action: 'choose-existing-runtime',
            detail: { code: 'existing_runtime', message: 'Existing runtime', retryable: false },
        };
        const screen = await renderScreen(
            <PersonalHomeSetupSurface
                snapshot={needsChoice}
                onUseExisting={() => {}}
                onUseAnotherHome={() => {}}
            />,
        );

        expect(screen.findByTestId('personal-home-existing-runtime-decision')).not.toBeNull();
        expect(screen.findByTestId('personal-home-use-existing-title')).not.toBeNull();
        expect(screen.findByTestId('personal-home-use-existing-subtitle')).not.toBeNull();
        expect(screen.findByTestId('personal-home-use-another-title')).not.toBeNull();
        expect(screen.findByTestId('personal-home-use-another-subtitle')).not.toBeNull();
        expect(screen.findByTestId('personal-home-bootstrap-failure')).toBeNull();
        expect(screen.findByTestId('personal-home-bootstrap-details-toggle')).not.toBeNull();
        await screen.pressByTestIdAsync('personal-home-bootstrap-details-toggle');
        expect(screen.findByTestId('personal-home-bootstrap-details-panel')).not.toBeNull();
        expect(screen.findAllHostsByTestId('personal-home-bootstrap-details-panel')).toHaveLength(1);
    });
    it('renders exactly one mark, one title and one status sentence in every snapshot state', async () => {
        for (const state of everySnapshotState()) {
            const screen = await renderScreen(
                <PersonalHomeSetupSurface
                    snapshot={state}
                    onRetry={() => {}}
                    onUseExisting={() => {}}
                    onUseAnotherHome={() => {}}
                />,
            );

            expect(screen.findAllHostsByTestId('personal-home-bootstrap-mark')).toHaveLength(1);
            expect(screen.root.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'header')).toHaveLength(1);
            expect(screen.findAllHostsByTestId('personal-home-bootstrap-phase')).toHaveLength(1);
        }
    });

    it('fills the mark only from derived milestones, never from an interpolated estimate', async () => {
        for (const state of everySnapshotState()) {
            const screen = await renderScreen(
                <PersonalHomeSetupSurface snapshot={state} onRetry={() => {}} onUseExisting={() => {}} onUseAnotherHome={() => {}} />,
            );
            const arc = screen.root.findByProps({ testID: 'personal-home-bootstrap-progress-arc' });
            const circumference = Number(arc.props.circumference ?? String(arc.props.strokeDasharray).split(' ')[0]);
            const filled = 1 - Number(arc.props.animatedProps?.strokeDashoffset ?? arc.props.strokeDashoffset ?? arc.props.dashOffset) / circumference;

            expect(filled).toBeCloseTo(derivePersonalHomeSetupProgress(state).fraction, 5);
            // One of exactly six quantised values: a time-based or event-counted fill cannot land here.
            expect([0, 1 / 5, 2 / 5, 3 / 5, 4 / 5, 1].some((allowed) => Math.abs(allowed - filled) < 1e-5)).toBe(true);
        }
    });

    it('stops the activity treatment but keeps the proven milestones visible when blocked', async () => {
        const blocked: PersonalHomeBootstrapSnapshot = {
            ...snapshot,
            phase: 'blocked',
            action: 'retry',
            progressMilestones: {
                runtimeHealthy: true,
                identityVerified: false,
                authenticated: false,
                signupClosed: false,
            },
            detail: { code: 'auth', message: 'Needs attention', retryable: true },
        };
        const screen = await renderScreen(<PersonalHomeSetupSurface snapshot={blocked} onRetry={() => {}} />);

        expect(screen.findByTestId('personal-home-bootstrap-activity')).toBeNull();
        expect(screen.findAllHostsByTestId('personal-home-bootstrap-mark')).toHaveLength(1);
        const arc = screen.root.findByProps({ testID: 'personal-home-bootstrap-progress-arc' });
        const circumference = Number(arc.props.circumference ?? String(arc.props.strokeDasharray).split(' ')[0]);
        expect(1 - Number(arc.props.animatedProps?.strokeDashoffset ?? arc.props.strokeDashoffset ?? arc.props.dashOffset) / circumference).toBeCloseTo(1 / 5, 5);
    });

    it('never announces or displays a percentage', async () => {
        for (const state of everySnapshotState()) {
            const screen = await renderScreen(
                <PersonalHomeSetupSurface snapshot={state} onRetry={() => {}} onUseExisting={() => {}} onUseAnotherHome={() => {}} />,
            );
            const announced = screen.root.findAll((node) => typeof node.type === 'string').flatMap((node) => [
                typeof node.props.children === 'string' ? node.props.children : null,
                typeof node.props.accessibilityLabel === 'string' ? node.props.accessibilityLabel : null,
                typeof node.props.accessibilityHint === 'string' ? node.props.accessibilityHint : null,
                typeof node.props.accessibilityValue?.text === 'string' ? node.props.accessibilityValue.text : null,
            ]).filter((value): value is string => value !== null);

            expect(announced.length).toBeGreaterThan(0);
            expect(announced.filter((value) => /%|percent/i.test(value))).toEqual([]);
        }
    });

    it.each([false, true])('uses the Home backdrop material with reduced transparency %s', async (reduced) => {
        transparency.reduced = reduced;
        try {
            const screen = await renderScreen(<PersonalHomeSetupSurface snapshot={snapshot} />);
            const root = screen.findAllHostsByTestId('personal-home-setup-surface')[0];
            const material = flattenStyle(root?.props.style);
            if (reduced) {
                expect(material.backdropFilter).toBeUndefined();
                expect(material.backgroundColor).toEqual(expect.any(String));
                expect(material.backgroundColor).not.toMatch(/transparent|rgba\([^)]*,\s*0?\.\d+\)/);
            } else {
                expect(material.backdropFilter).toMatch(/^blur\(/);
            }
        } finally {
            transparency.reduced = false;
        }
    });
    it('names the erased Home distinctly and never promotes raw diagnostic text to primary copy', async () => {
        const erased: PersonalHomeBootstrapSnapshot = {
            ...snapshot,
            phase: 'blocked',
            action: 'retry',
            detail: {
                code: 'personal_home_erased',
                message: 'Your Personal Home was erased. Try again to create a new one.',
                retryable: true,
            },
        };
        const erasedScreen = await renderScreen(<PersonalHomeSetupSurface snapshot={erased} onRetry={() => {}} />);
        const erasedText = erasedScreen.getTextContent();
        expect(erasedText).toContain(tLoose('personalHome.bootstrap.blocked.personal_home_erased'));
        expect(erasedText).toContain(tLoose('personalHome.bootstrap.blockedBody.personal_home_erased'));
        // The generic body promises the user's completed setup work is safe, which is
        // false once the Home's data was deleted.
        expect(erasedText).not.toContain(tLoose('personalHome.bootstrap.failureBody'));

        const unmapped: PersonalHomeBootstrapSnapshot = {
            ...snapshot,
            phase: 'blocked',
            action: 'retry',
            detail: { code: 'credential_write_failed', message: 'seed=abcdef0123456789abcdef0123456789', retryable: true },
        };
        const unmappedScreen = await renderScreen(<PersonalHomeSetupSurface snapshot={unmapped} onRetry={() => {}} />);
        const unmappedText = unmappedScreen.getTextContent();
        expect(unmappedText).toContain(tLoose('personalHome.bootstrap.blockedStatus'));
        expect(unmappedText).not.toContain('abcdef0123456789abcdef0123456789');
    });
});

function everySnapshotState(): readonly PersonalHomeBootstrapSnapshot[] {
    return [
        { ...snapshot, phase: 'checking' },
        { ...snapshot, phase: 'ensuring-home' },
        { ...snapshot, phase: 'preparing-computer', homeReady: true, shouldGateShell: false },
        { ...snapshot, phase: 'blocked', action: 'retry', detail: { message: 'Needs attention', retryable: true } },
        {
            ...snapshot,
            phase: 'blocked',
            action: 'choose-existing-runtime',
            detail: { code: 'existing_runtime', message: 'Existing runtime', retryable: false },
        },
        { ...snapshot, phase: 'ready', homeReady: true, daemonReady: true, daemonState: 'ready', shouldGateShell: false },
    ];
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((merged, entry) => ({ ...merged, ...flattenStyle(entry) }), {});
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}
