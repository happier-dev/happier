import { getAgentCore } from '@/agents/catalog/catalog';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents/runtime/identity/resolveAgentIdFromSessionMetadata';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { resolveExecutionRunTitle } from '@/components/sessions/runs/resolveExecutionRunTitle';
import { describeEffectiveModelMode } from '@/sync/domains/models/describeEffectiveModelMode';
import { resolveSessionModelLabel } from '@/sync/domains/models/modelOptions';

import { t } from '@/text';

import { createSubagentToolPresenter, type ToolTitleTranslator } from '@happier-dev/session-core/tools';

export const resolveSubagentToolPresentation = createSubagentToolPresenter({
    getAgentCore, resolveSessionAgentId: resolveAgentIdFromSessionMetadata, formatAgentLikeIdForDisplay, resolveExecutionRunBackendLabel,
    resolveExecutionRunTitle, describeEffectiveModelMode, resolveSessionModelLabel, t: t as ToolTitleTranslator,
});
