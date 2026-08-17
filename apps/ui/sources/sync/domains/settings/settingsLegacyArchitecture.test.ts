import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const UI_SOURCES_ROOT = join(__dirname, '..', '..', '..');

const ALLOWED_COMPATIBILITY_ONLY_FILES = new Set([
    'sync/domains/settings/parse/accountSettingsCompatibilityMigrations.ts',
]);

const COMPATIBILITY_ONLY_SETTING_KEY_PATTERN =
    /['"`](compactSessionView|compactSessionViewMinimal|usePickerSearch|lastUsedPermissionMode|lastUsedModelMode|reviewPromptAnswered|reviewPromptLikedApp|inferenceOpenAIKey|viewInline|expandTodos)['"`]/;

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

describe('settings legacy architecture', () => {
    it('keeps compatibility-only legacy setting keys out of modern production modules', () => {
        const violations = walkSourceFiles(UI_SOURCES_ROOT)
            .map((fullPath) => ({
                relativePath: relative(UI_SOURCES_ROOT, fullPath).replaceAll('\\', '/'),
                contents: readFileSync(fullPath, 'utf8'),
            }))
            .filter(({ relativePath, contents }) => {
                if (ALLOWED_COMPATIBILITY_ONLY_FILES.has(relativePath)) return false;
                return COMPATIBILITY_ONLY_SETTING_KEY_PATTERN.test(contents);
            })
            .map(({ relativePath }) => relativePath)
            .sort();

        expect(violations).toEqual([]);
    });

    it('keeps released OpenAI-compatible speech compatibility role-qualified and Chat-isolated', () => {
        const readSource = (relativePath: string) => readFileSync(join(UI_SOURCES_ROOT, relativePath), 'utf8');
        const accountIngress = readSource('sync/domains/settings/parse/accountSettingsCompatibilityMigrations.ts');
        const voicePersistence = readSource('sync/domains/settings/voiceSettingsPersistence.ts');
        const providerProjection = readSource('voice/settings/providerSettings.ts');
        const speechMigrations = readSource('sync/domains/settings/migrations/speechProviders.ts');
        const credentialItem = readSource('voice/credentials/CredentialItem.tsx');

        expect(accountIngress).not.toMatch(/stt_api_key|tts_api_key/);
        expect(voicePersistence).not.toMatch(/stt_api_key|tts_api_key|providerId === 'openai_compat'/);
        expect(providerProjection).toContain("'happier.voice.openai-compat/stt'");
        expect(providerProjection).toContain("'happier.voice.openai-compat/tts'");
        expect(providerProjection).not.toContain('chatApiKey');
        expect(speechMigrations.slice(
            speechMigrations.indexOf('export function projectPredecessorSpeechProviderConfig'),
        )).toContain('OPENAI_COMPAT_STT_ID');
        expect(speechMigrations.slice(
            speechMigrations.indexOf('export function projectPredecessorSpeechProviderConfig'),
        )).toContain('OPENAI_COMPAT_TTS_ID');
        expect(credentialItem).not.toContain('until its STT/TTS cutover lands');
        expect(credentialItem).not.toContain('qualified secret until');
    });
});
