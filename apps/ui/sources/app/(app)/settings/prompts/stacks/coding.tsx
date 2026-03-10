import * as React from 'react';

import { PromptStackEditorScreen } from '@/components/settings/prompts/stacks/PromptStackEditorScreen';
import { t } from '@/text';

export default function CodingPromptStackRoute() {
  return <PromptStackEditorScreen surface="coding" title={t('promptLibrary.codingStack')} />;
}
