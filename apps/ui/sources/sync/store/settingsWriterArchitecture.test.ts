import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const UI_SOURCES_ROOT = join(__dirname, '..', '..');

const ALLOWED_DIRECT_ACCOUNT_WRITE_FILES = new Set([
    'components/onboarding/checklists/remoteSsh/persistRemoteHostAfterRemoteSshCompletion.ts',
    'components/sessions/new/modules/newSessionDraftLifecycle.ts',
    'sync/ops/actions/defaultActionExecutor.ts',
    'sync/store/settingsWriters.ts',
    'voice/persistence/invalidatePersistentVoiceTranscript.ts',
    'voice/persistence/voiceAutoTargetMachineSettings.ts',
]);

const ALLOWED_DIRECT_LOCAL_WRITE_FILES = new Set([
    'hooks/server/useHomeViewSelectionSettings.ts',
    'sync/ops/actions/connectedServiceActionDeps.ts',
    'sync/ops/actions/defaultActionExecutor.ts',
    'sync/store/settingsWriters.ts',
    'sync/store/domains/settings.ts',
    'sync/domains/settings/localSettings.ts',
]);

/**
 * `applySettingsLocal` is the settings store's internal projection leaf. Reaching it directly
 * skips scope admission, sealing, pending merge, analytics and server synchronization, so every
 * entry here is named with the reason it is not a server-backed Account write (Lane 07.6 §2).
 */
const ALLOWED_RAW_LOCAL_PROJECTION_FILES = new Set([
    // The canonical settings engine and store: this projection is their own implementation.
    'sync/engine/settings/syncSettings.ts',
    'sync/store/domains/settings.ts',
    // The one catalogued local-only compatibility projection: device/tab Home selection is owned
    // by the device-global Home-view state and must never enter Account-settings sync.
    'hooks/server/useHomeViewSelectionSettings.ts',
    // Test, development and Voice-QA harnesses that install fixture settings into a throwaway runtime.
    // They ship in the source tree but are never a product write path for a real Account.
    'components/sessions/files/views/sessionFilesViewTestkit.ts',
    'dev/testkit/harness/standaloneVoicePolicyHarness.ts',
    'dev/testkit/harness/useVoiceSurfaceE2eFixtureComposition.ts',
    'voice/qa/voiceQaRecordedAudioController.ts',
    'voice/qa/voiceQaTemporarySettingsScope.ts',
]);

function walkSourceFiles(root: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(root)) {
        const fullPath = join(root, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            if (entry === 'node_modules') continue;
            results.push(...walkSourceFiles(fullPath));
            continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (/\.(test|spec)\.(ts|tsx)$/.test(entry)) continue;
        results.push(fullPath);
    }
    return results;
}

// This is an architecture inventory, not three independent filesystem tests.
// Read the production corpus once so the assertions remain cheap even as the
// UI source tree grows.
const PRODUCTION_SOURCE_FILES = walkSourceFiles(UI_SOURCES_ROOT).map((fullPath) => ({
    relativePath: relative(UI_SOURCES_ROOT, fullPath).replaceAll('\\', '/'),
    contents: readFileSync(fullPath, 'utf8'),
}));

function collectViolations(pattern: RegExp, allowlist: Set<string>): string[] {
    return PRODUCTION_SOURCE_FILES
        .filter(({ relativePath, contents }) => pattern.test(contents) && !allowlist.has(relativePath))
        .map(({ relativePath }) => relativePath)
        .sort();
}

describe('settings writer architecture', () => {
    it('keeps direct sync.applySettings usage inside approved writer and system files only', () => {
        const violations = collectViolations(
            /(?:\bsync|getSyncSingleton\(\))\.applySettings\s*\(/,
            ALLOWED_DIRECT_ACCOUNT_WRITE_FILES,
        );
        expect(violations).toEqual([]);
    });

    it('keeps direct local settings store writes inside approved writer files only', () => {
        const violations = collectViolations(/applyLocalSettings\s*\([^)]*,\s*\{\s*source:/, ALLOWED_DIRECT_LOCAL_WRITE_FILES);
        expect(violations).toEqual([]);
    });

    it('keeps raw Account-settings local projection out of production server-backed writers', () => {
        const violations = collectViolations(/applySettingsLocal\s*\(/, ALLOWED_RAW_LOCAL_PROJECTION_FILES);
        expect(violations).toEqual([]);
    });

    it('does not reintroduce the obsolete lower-currentness Account-settings replacement branch', () => {
        expect(collectViolations(/replaceSettingsForScope\s*[:(]/, new Set())).toEqual([]);
    });
});
