import * as React from 'react';

import { PromptStackEditorScreen } from '@/components/settings/prompts/stacks/PromptStackEditorScreen';
import { t } from '@/text';

export function CodingPromptStackRoute() {
  return <PromptStackEditorScreen surface="coding" title={t('contextPages.account.title')} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { CodingPromptStackRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={CodingPromptStackRoute} />; }
