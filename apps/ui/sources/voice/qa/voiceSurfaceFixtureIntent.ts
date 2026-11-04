import { useLocalSearchParams } from 'expo-router';

import { isVoiceQaDebugRuntime } from './voiceQaDebugRuntime';

const VOICE_SURFACE_E2E_FIXTURE_QUERY_PARAM = 'happier_voice_e2e_fixture';
const VOICE_SURFACE_E2E_FIXTURE_STORAGE_KEY = 'happier.voice.e2e.fixture';

function normalizeFixtureParam(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' ? value[0].trim() : '';
    }
    return typeof value === 'string' ? value.trim() : '';
}

function readPersistedFixtureId(): string {
    const localStorage =
        typeof globalThis !== 'undefined' && typeof globalThis.localStorage?.getItem === 'function'
            ? globalThis.localStorage
            : null;
    if (!localStorage) return '';
    return normalizeFixtureParam(localStorage.getItem(VOICE_SURFACE_E2E_FIXTURE_STORAGE_KEY) ?? undefined);
}

/** Routing needs the QA intent before the optional fixture implementation arrives. */
export function useVoiceSurfaceFixtureIntent(): Readonly<{
    runtimeEnabled: boolean;
    fixtureId: string;
    shouldSuppressOnboarding: boolean;
}> {
    const params = useLocalSearchParams<{ happier_voice_e2e_fixture?: string | string[] }>();
    const runtimeEnabled = isVoiceQaDebugRuntime();
    const fixtureId = runtimeEnabled
        ? normalizeFixtureParam(params[VOICE_SURFACE_E2E_FIXTURE_QUERY_PARAM]) || readPersistedFixtureId()
        : '';
    return { runtimeEnabled, fixtureId, shouldSuppressOnboarding: fixtureId.length > 0 };
}
