import { expect, type Page } from '@playwright/test';

import { createTestAuth } from '../auth';
import { buildAuthBootstrapStorageSnapshot } from './buildAuthBootstrapStorageSnapshot';
import { installAuthBootstrapStorageSnapshot } from './readLegacyAuthSecretFromLocalStorage';
import {
    gotoDomContentLoadedWithRetries,
} from './pageNavigation';
import { seedDismissedPendingSetupIntent } from './pendingSetupIntent';

export const VOICE_SURFACE_E2E_FIXTURE_QUERY_PARAM = 'happier_voice_e2e_fixture';
export const VOICE_SURFACE_E2E_FIXTURE_STORAGE_KEY = 'happier.voice.e2e.fixture';
export const VOICE_SURFACE_E2E_FIXTURE_SIDEBAR_HIDDEN_CONVERSATION = 'sidebar_hidden_conversation';
export const VOICE_SURFACE_E2E_FIXTURE_REALTIME_RECOVERABLE_DISCONNECT = 'realtime_recoverable_disconnect';
export const VOICE_SURFACE_E2E_FIXTURE_LOCAL_AUTO_RETURN_LISTENING = 'local_auto_return_listening';
export const VOICE_SURFACE_E2E_FIXTURE_WELCOME_RESUME_PERSISTENCE = 'welcome_resume_persistence';
export const VOICE_SURFACE_E2E_FIXTURE_DAEMON_INFERENCE_WEB_FALLBACK_PARITY = 'daemon_inference_web_fallback_parity';
export const VOICE_SURFACE_E2E_FIXTURE_CANCEL_DURING_ASSISTANT_SPEECH = 'cancel_during_assistant_speech';

export const VOICE_SURFACE_E2E_CONTROL_SESSION_ID = '__voice_agent__';
export const VOICE_SURFACE_E2E_CONVERSATION_SESSION_ID = 'voice-e2e-hidden-conversation';
export const VOICE_SURFACE_E2E_ROOT_SESSION_ID = 'voice-e2e-root-session';

export const VOICE_SURFACE_E2E_MESSAGE_IDS = {
    user: 'voice-e2e-user-1',
    assistant: 'voice-e2e-assistant-1',
} as const;

export async function openVoiceE2eConversationFromSidebar(params: Readonly<{
    page: Page;
    timeoutMs?: number;
}>): Promise<void> {
    const timeoutMs = params.timeoutMs ?? 120_000;
    await params.page.getByTestId('voice-surface-open:sidebar').click({ timeout: timeoutMs });
    await expect(params.page).toHaveURL(new RegExp(`/session/${VOICE_SURFACE_E2E_CONVERSATION_SESSION_ID}$`), {
        timeout: timeoutMs,
    });
    await expect(params.page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: timeoutMs });
}

export function buildVoiceSurfaceFixtureUrl(params: Readonly<{
    uiBaseUrl: string;
    serverBaseUrl: string;
    fixtureId: string;
    path?: string;
}>): string {
    const url = new URL(params.path ?? '/', params.uiBaseUrl.endsWith('/') ? params.uiBaseUrl : `${params.uiBaseUrl}/`);
    url.searchParams.set('happier_hmr', '0');
    url.searchParams.set('server', params.serverBaseUrl);
    url.searchParams.set(VOICE_SURFACE_E2E_FIXTURE_QUERY_PARAM, params.fixtureId);
    return url.toString();
}

export async function primeVoiceSurfaceFixtureSettings(
    page: Page,
    fixtureId: string = VOICE_SURFACE_E2E_FIXTURE_SIDEBAR_HIDDEN_CONVERSATION,
): Promise<void> {
    const applyFixtureSettings = (nextFixtureId: string) => {
        const settingsKey = 'mmkv.default\\settings';
        const pendingSettingsKey = 'mmkv.default\\pending-settings';
        const fixtureStorageKey = 'happier.voice.e2e.fixture';

        const parseRecord = (raw: string | null): Record<string, unknown> => {
            if (!raw) return {};
            try {
                const parsed = JSON.parse(raw) as unknown;
                return typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : {};
            } catch {
                return {};
            }
        };

        const persistedEnvelope = parseRecord(window.localStorage.getItem(settingsKey));
        const persistedSettings =
            typeof persistedEnvelope.settings === 'object' && persistedEnvelope.settings
                ? persistedEnvelope.settings as Record<string, unknown>
                : {};
        const pendingSettings = parseRecord(window.localStorage.getItem(pendingSettingsKey));
        const persistedVoice =
            typeof persistedSettings.voice === 'object' && persistedSettings.voice
                ? persistedSettings.voice as Record<string, unknown>
                : {};
        const pendingVoice =
            typeof pendingSettings.voice === 'object' && pendingSettings.voice
                ? pendingSettings.voice as Record<string, unknown>
                : {};
        const persistedFeatureToggles =
            typeof persistedSettings.featureToggles === 'object' && persistedSettings.featureToggles
                ? persistedSettings.featureToggles as Record<string, unknown>
                : {};
        const pendingFeatureToggles =
            typeof pendingSettings.featureToggles === 'object' && pendingSettings.featureToggles
                ? pendingSettings.featureToggles as Record<string, unknown>
                : {};
            const buildFixtureVoiceSettings = (
                currentFixtureId: string,
                existingVoice: Record<string, unknown>,
            ): Record<string, unknown> => {
                const existingProviders =
                    typeof existingVoice.providers === 'object' && existingVoice.providers
                        ? existingVoice.providers as Record<string, unknown>
                        : {};
                const existingRealtimeEnvelope =
                    typeof existingProviders['happier.voice.elevenlabs/realtime-elevenlabs'] === 'object' && existingProviders['happier.voice.elevenlabs/realtime-elevenlabs']
                        ? existingProviders['happier.voice.elevenlabs/realtime-elevenlabs'] as Record<string, unknown>
                        : {};
                const existingRealtimeConfig =
                    typeof existingRealtimeEnvelope.config === 'object' && existingRealtimeEnvelope.config
                        ? existingRealtimeEnvelope.config as Record<string, unknown>
                        : {};
                const existingLocalConversationEnvelope =
                    typeof existingProviders.local_conversation === 'object' && existingProviders.local_conversation
                        ? existingProviders.local_conversation as Record<string, unknown>
                        : {};
                const existingLocalConversationConfig =
                    typeof existingLocalConversationEnvelope.config === 'object' && existingLocalConversationEnvelope.config
                        ? existingLocalConversationEnvelope.config as Record<string, unknown>
                        : {};
                const existingUi =
                    typeof existingVoice.ui === 'object' && existingVoice.ui
                        ? existingVoice.ui as Record<string, unknown>
                        : {};

            const commonUi = {
                ...existingUi,
                activityFeedEnabled: true,
                scopeDefault: 'global',
                surfaceLocation: 'auto',
            };

            switch (currentFixtureId) {
                case 'local_auto_return_listening':
                case 'daemon_inference_web_fallback_parity':
                    // These fixtures exercise local-conversation / daemon state transitions driven by
                    // the in-app e2e fixture runtime. They require `providerId=local_conversation`.
                    return {
                        ...existingVoice,
                        providerId: 'local_conversation',
                        providers: {
                            ...existingProviders,
                            local_conversation: { schemaVersion: 1, config: {
                                ...existingLocalConversationConfig,
                                conversationMode: 'direct_session',
                            } },
                        },
                        ui: commonUi,
                    };
                case 'cancel_during_assistant_speech':
                case 'welcome_resume_persistence':
                    // This fixture validates resumable welcome behavior but keeps the active provider
                    // on a web-friendly realtime adapter while reusing local-conversation transcript
                    // projection/binding seams.
                    return {
                        ...existingVoice,
                        providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                        providers: {
                            ...existingProviders,
                            'happier.voice.elevenlabs/realtime-elevenlabs': { schemaVersion: 2, config: {
                                ...existingRealtimeConfig,
                                billingMode: 'byo',
                            } },
                        },
                        ui: commonUi,
                    };
                case 'sidebar_hidden_conversation':
                case 'realtime_recoverable_disconnect':
                default:
                    return {
                        ...existingVoice,
                        providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                        providers: {
                            ...existingProviders,
                            'happier.voice.elevenlabs/realtime-elevenlabs': { schemaVersion: 2, config: {
                                ...existingRealtimeConfig,
                                billingMode: 'byo',
                            } },
                        },
                        ui: commonUi,
                    };
            }
        };
        const buildFixtureFeatureToggles = (
            currentFixtureId: string,
            existingFeatureToggles: Record<string, unknown>,
        ): Record<string, unknown> => ({
            ...existingFeatureToggles,
            voice: true,
            'execution.runs': true,
            'voice.agent': true,
            ...(currentFixtureId === 'daemon_inference_web_fallback_parity'
                ? { 'voice.daemonInference': true }
                : null),
        });
        const voice = buildFixtureVoiceSettings(nextFixtureId, persistedVoice);

        persistedEnvelope.settings = {
            ...persistedSettings,
            experiments: true,
            featureToggles: buildFixtureFeatureToggles(nextFixtureId, persistedFeatureToggles),
            voice,
        };

        window.localStorage.setItem(settingsKey, JSON.stringify(persistedEnvelope));
        window.localStorage.setItem(fixtureStorageKey, nextFixtureId);
        window.localStorage.setItem(
            pendingSettingsKey,
            JSON.stringify({
                ...pendingSettings,
                experiments: true,
                featureToggles: buildFixtureFeatureToggles(nextFixtureId, pendingFeatureToggles),
                voice: buildFixtureVoiceSettings(nextFixtureId, pendingVoice),
            }),
        );
    };

    await page.addInitScript(applyFixtureSettings, fixtureId);
    try {
        await page.evaluate(applyFixtureSettings, fixtureId);
    } catch {
        // localStorage may be inaccessible on opaque origins (e.g. about:blank) before navigation.
        // The init script will still apply the snapshot once the page loads the target origin.
    }
}

export async function reachSidebarVoiceSurfaceFixtureHome(params: Readonly<{
    page: Page;
    uiBaseUrl: string;
    serverBaseUrl: string;
    storageScope: string;
    fixtureId?: string;
    timeoutMs?: number;
}>): Promise<void> {
    const fixtureId = params.fixtureId ?? VOICE_SURFACE_E2E_FIXTURE_SIDEBAR_HIDDEN_CONVERSATION;
    const fixtureUrl = buildVoiceSurfaceFixtureUrl({
        uiBaseUrl: params.uiBaseUrl,
        serverBaseUrl: params.serverBaseUrl,
        fixtureId,
    });

    // Ensure a clean slate for the first navigation in this tab. Export-mode UI builds bake a single
    // storage scope at build time, so tests cannot rely on per-run scoping for isolation.
    const clearStorageOnce = () => {
        const markerKey = '__happier_ui_e2e_storage_cleared_v1';
        try {
            if (window.sessionStorage.getItem(markerKey) === '1') return;
        } catch {
            // ignore and attempt clearing anyway
        }
        try {
            window.localStorage.clear();
        } catch {
            // ignore
        }
        try {
            window.sessionStorage.clear();
            window.sessionStorage.setItem(markerKey, '1');
        } catch {
            // ignore
        }
    };
    await params.page.addInitScript(clearStorageOnce);

    // Prevent the authenticated home route from auto-opening the machine setup wizard (which hides
    // the underlying shell and blocks voice surface assertions). The UI persists `pendingSetupIntent`
    // on web; we seed both the current and legacy (MMKV-style) keys for forward/back compatibility.
    await seedDismissedPendingSetupIntent(params.page, params.storageScope);

    // Avoid flaky UI-driven onboarding in e2e: bootstrap auth credentials directly into storage so
    // the UI loads into an authenticated shell deterministically (especially in no-dev + CI mode).
    const storageScope = params.storageScope.trim();
    const auth = await createTestAuth(params.serverBaseUrl);
    await installAuthBootstrapStorageSnapshot(
        params.page,
        buildAuthBootstrapStorageSnapshot({
            serverUrl: params.serverBaseUrl,
            auth,
            mode: 'dataKey',
            storageScope,
        }),
    );

    await primeVoiceSurfaceFixtureSettings(params.page, fixtureId);
    const timeoutMs = params.timeoutMs ?? 180_000;
    const startedAtMs = Date.now();
    const navigationTimeoutMs = Math.min(timeoutMs, 90_000);
    await gotoDomContentLoadedWithRetries(params.page, fixtureUrl, navigationTimeoutMs);

    // Give React Native Web a moment to paint the initial shell before capturing diagnostics.
    // In export-mode builds, the route JS can take a beat to hydrate after DOMContentLoaded.
    await params.page.waitForTimeout(1500);

    // Capture a cheap early DOM snapshot of voice-related test IDs before running any
    // long waits. This helps debug cases where the page becomes busy later (e.g. heavy
    // sync/voice runtime initialization) and `page.evaluate()` calls start timing out.
    const earlyVoiceTestIds = await (async () => {
        try {
                    return await params.page.evaluate(() => {
                        try {
                            const out: string[] = [];
                            const nodes = document.querySelectorAll('[data-testid]');
                            for (let i = 0; i < nodes.length; i++) {
                                const node = nodes.item(i);
                                if (!node) continue;
                                const id = node.getAttribute('data-testid');
                                if (typeof id === 'string' && id.startsWith('voice-surface')) {
                                    out.push(id);
                                    if (out.length >= 25) break;
                                }
                            }
                            return out;
                        } catch {
                            return [];
                        }
                    });
        } catch {
            return null;
        }
    })();
    const earlyDataTestIds = await (async () => {
        try {
                    return await params.page.evaluate(() => {
                        try {
                            const out: string[] = [];
                            const nodes = document.querySelectorAll('[data-testid]');
                            for (let i = 0; i < nodes.length; i++) {
                                const node = nodes.item(i);
                                if (!node) continue;
                                const id = node.getAttribute('data-testid');
                                if (typeof id === 'string' && id) {
                                    out.push(id);
                                    if (out.length >= 25) break;
                                }
                            }
                            return out;
                        } catch {
                            return [];
                        }
                    });
        } catch {
            return null;
        }
    })();

    // Voice specs interact with sidebar controls immediately; if the setup wizard modal is present it
    // intercepts pointer events and can hide the underlying shell. Prefer a best-effort "skip" click
    // without relying on raw `locator.count()` calls (those can hang indefinitely if the page is busy).
    try {
        await params.page.keyboard.press('Escape');
    } catch {
        // ignore
    }
    const tryClick = async (locator: any, timeout: number): Promise<boolean> => {
        try {
            await locator.click({ timeout, force: true });
            return true;
        } catch {
            return false;
        }
    };
    const setupWizardSurface = params.page.getByTestId('setupWizard.surface');
    let wizardDismissed = false;
    try {
        await expect(setupWizardSurface).toHaveCount(0, { timeout: 1_000 });
        wizardDismissed = true;
    } catch {
        // wizard still visible
    }
    if (!wizardDismissed) {
        await tryClick(params.page.getByTestId('setupWizard.surface-skip'), 10_000);
        // Best-effort dismissal: some wizard steps intentionally hide skip, and we don't want the
        // whole voice fixture to hang for minutes when the setup wizard is non-dismissible.
        try {
            await expect(setupWizardSurface).toHaveCount(0, { timeout: 15_000 });
        } catch {
            // continue
        }
    }

    const withTimeout = async <T,>(promise: Promise<T>, ms: number): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            return await Promise.race([
                promise,
                new Promise<T>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    try {
        const elapsedMs2 = Date.now() - startedAtMs;
        const remainingMs2 = Math.max(5_000, timeoutMs - elapsedMs2);
        const waitMs = Math.min(remainingMs2, 120_000);
        // Guard the Playwright expectation itself with a hard timer so a hung page can't
        // consume the whole test timeout and prevent screenshots/diagnostics.
        await withTimeout(
            expect(params.page.getByTestId('voice-surface:sidebar')).toHaveCount(1, { timeout: waitMs }),
            waitMs + 5_000,
        );
    } catch (error) {
        const getCount = async (testId: string): Promise<string> => {
            try {
                return String(await withTimeout(params.page.getByTestId(testId).count(), 2_000));
            } catch (countError) {
                const message = countError instanceof Error ? countError.message : String(countError);
                return `error:${message.slice(0, 200)}`;
            }
        };
        const getDataTestIdMatches = async (prefix: string): Promise<string> => {
            try {
                const matches = await withTimeout(params.page.evaluate((p) => {
                    try {
                        const out: string[] = [];
                        const nodes = document.querySelectorAll('[data-testid]');
                        for (let i = 0; i < nodes.length; i++) {
                            const node = nodes.item(i);
                            if (!node) continue;
                            const id = node.getAttribute('data-testid');
                            if (typeof id === 'string' && id.startsWith(p)) {
                                out.push(id);
                                if (out.length >= 25) break;
                            }
                        }
                        return out;
                    } catch {
                        return [];
                    }
                }, prefix), 2_000);
                return JSON.stringify(matches).slice(0, 500);
            } catch (evalError) {
                const message = evalError instanceof Error ? evalError.message : String(evalError);
                return `error:${message.slice(0, 200)}`;
            }
        };
        const getHasBodyText = async (needle: string): Promise<string> => {
            try {
                const found = await withTimeout(params.page.evaluate((text) => {
                    try {
                        return String(document.body?.textContent ?? '').includes(text);
                    } catch {
                        return false;
                    }
                }, needle), 2_000);
                return String(found);
            } catch (evalError) {
                const message = evalError instanceof Error ? evalError.message : String(evalError);
                return `error:${message.slice(0, 200)}`;
            }
        };
        const diagnostics = [
            `url=${params.page.url()}`,
            `earlyVoiceTestIds=${earlyVoiceTestIds == null ? 'error' : JSON.stringify(earlyVoiceTestIds).slice(0, 500)}`,
            `earlyDataTestIds=${earlyDataTestIds == null ? 'error' : JSON.stringify(earlyDataTestIds).slice(0, 500)}`,
            `sidebar-view=${await getCount('sidebar-view')}`,
            `setupWizard.surface=${await getCount('setupWizard.surface')}`,
            `welcome-create-account=${await getCount('welcome-create-account')}`,
            `main-header-start-new-session=${await getCount('main-header-start-new-session')}`,
            `voice-surface:sidebar=${await getCount('voice-surface:sidebar')}`,
            `voiceAssistantText=${await getHasBodyText('Voice Assistant')}`,
            `dataTestIds.voice-surface=${await getDataTestIdMatches('voice-surface')}`,
            `dataTestIds.voice-surface-mode=${await getDataTestIdMatches('voice-surface-mode')}`,
            `dataTestIds.voice-surface-status=${await getDataTestIdMatches('voice-surface-status')}`,
        ].join('\n');
        throw new Error(`Sidebar voice surface did not appear within ${timeoutMs}ms.\n${diagnostics}`, { cause: error as any });
    }
}
