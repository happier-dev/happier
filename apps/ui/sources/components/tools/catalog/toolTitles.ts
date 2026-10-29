import { createToolTitleCatalog, type ToolTitleTranslator } from '@happier-dev/session-core/tools';
import { t } from '@/text';
import { resolveSubagentToolPresentation } from './core/subAgentPresentation';

const titles = createToolTitleCatalog({ translate: t as ToolTitleTranslator,
    subagentTitle: options => resolveSubagentToolPresentation(options).title });

/** UI catalog entries retain their renderer/schema metadata and delegate title policy. */
export function createKnownToolTitle(name: keyof typeof titles) {
    return titles[name];
}
