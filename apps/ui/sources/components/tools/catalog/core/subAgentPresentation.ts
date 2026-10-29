import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { resolveExecutionRunTitle } from '@/components/sessions/runs/resolveExecutionRunTitle';
import { describeEffectiveModelMode } from '@/sync/domains/models/describeEffectiveModelMode';
import { resolveSessionModelLabel } from '@/sync/domains/models/modelOptions';

import { t } from '@/text';

import { createSubagentToolPresenter, type ToolTitleTranslator } from '@happier-dev/session-core/tools';

export const resolveSubagentToolPresentation = createSubagentToolPresenter({
    getAgentCore, resolveAgentIdFromFlavor, formatAgentLikeIdForDisplay, resolveExecutionRunBackendLabel,
    resolveExecutionRunTitle, describeEffectiveModelMode, resolveSessionModelLabel, t: t as ToolTitleTranslator,
});
