import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SOURCES_ROOT = join(process.cwd(), 'sources');

const intents = ['dictation', 'conversations', 'privacy', 'advanced'] as const;

describe('Voice settings intent import isolation', () => {
  it.each(intents)('%s route imports only its intent-owned screen', (intent) => {
    const route = readFileSync(
      join(SOURCES_ROOT, `app/(app)/settings/voice/${intent}.tsx`),
      'utf8',
    );
    const screenName = `Voice${intent[0]!.toUpperCase()}${intent.slice(1)}SettingsScreen`;

    expect(route).toContain(`@/voice/settings/screens/${screenName}`);
    expect(route).not.toContain('VoiceSettingsIntentDetailsScreen');
    for (const otherIntent of intents.filter((candidate) => candidate !== intent)) {
      expect(route).not.toContain(
        `Voice${otherIntent[0]!.toUpperCase()}${otherIntent.slice(1)}SettingsScreen`,
      );
    }
  });

  it('Privacy and Dictation do not statically import conversation settings subtrees', () => {
    const forbiddenConversationImports = [
      'VoiceProviderSection',
      'BundledConversationSettingsSection',
      'LocalDirectSection',
      'LocalConversationSection',
      'VoiceConversationsSettingsScreen',
    ];

    for (const screenName of ['VoicePrivacySettingsScreen', 'VoiceDictationSettingsScreen']) {
      const source = readFileSync(
        join(SOURCES_ROOT, `voice/settings/screens/${screenName}.tsx`),
        'utf8',
      );
      const imports = source
        .split('\n')
        .filter((line) => /^\s*import\b/.test(line))
        .join('\n');

      for (const token of forbiddenConversationImports) {
        expect(imports, `${screenName} must not import ${token}`).not.toContain(token);
      }
    }
  });
});
