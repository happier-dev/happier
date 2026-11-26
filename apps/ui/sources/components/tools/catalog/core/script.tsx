import { t } from '@/text';
import { ScriptToolInputV2Schema, ScriptToolResultV2Schema } from '@happier-dev/protocol/tools/v2';
import type { Message, ToolCall } from '@happier-dev/session-core/messages';
import type { Metadata } from '@happier-dev/session-core/state';
import { resolveScriptToolTitle } from '@happier-dev/session-core/tools';

import { formatScriptSubtitle } from '../../renderers/workflow/scriptDisplay';
import type { KnownToolDefinition } from '../_types';
import { ICON_SCRIPT } from '../icons';

/** A script the agent ran (native code mode or `happier tools run`): its intent as the title, count and duration under it. */
export const coreScriptTools = {
    Script: {
        title: (options) => resolveScriptToolTitle(options, () => t('tools.script.title')),
        icon: ICON_SCRIPT,
        isMutable: true,
        // The body states the script's own error in full; the header keeps its summary.
        hideDefaultError: true,
        input: ScriptToolInputV2Schema,
        result: ScriptToolResultV2Schema,
        extractSubtitle: (opts: { metadata: Metadata | null; tool: ToolCall; messages?: readonly Message[] }) => formatScriptSubtitle(opts.tool, opts.messages),
    },
} satisfies Record<string, KnownToolDefinition>;
