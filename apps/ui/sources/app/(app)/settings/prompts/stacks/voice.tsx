import * as React from 'react';

import { PromptStackEditorScreen } from '@/components/settings/prompts/stacks/PromptStackEditorScreen';
import { t } from '@/text';

export default function VoicePromptStackRoute() {
  return <PromptStackEditorScreen surface="voice" title={t('promptLibrary.voiceStack')} />;
}
