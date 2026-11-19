import { buildMessageRouteId, type Message, type ToolCallMessage } from '@happier-dev/session-core/messages';
import { isGenericSubAgentToolName, readSubAgentToolSidechainId } from '@happier-dev/protocol/tools/v2';

export type NativeSubagentNicknameAnchor = Readonly<{
    sidechainId: string;
    parentSidechainId: string | null;
    nickname: string | null;
    toolMessageRouteId: string;
    message: ToolCallMessage;
}>;

/** Native spawn facts and their existing destinations, through the transcript's sidechain identity reader. */
export function readNativeSubagentNicknameAnchors(
    messages: Iterable<Message>,
    rootThreadId: string | null,
): readonly NativeSubagentNicknameAnchor[] {
    const anchors: NativeSubagentNicknameAnchor[] = [];
    function visit(rows: Iterable<Message>, enclosingSidechainId: string | null): void {
        for (const message of rows) {
            if (message.kind !== 'tool-call') continue;
            const tool = message.tool;
            if (!isGenericSubAgentToolName(tool.name)) {
                visit(message.children, enclosingSidechainId);
                continue;
            }
            const sidechainId = readSubAgentToolSidechainId(tool, tool.name);
            if (!sidechainId) {
                visit(message.children, enclosingSidechainId);
                continue;
            }
            const input = tool.input && typeof tool.input === 'object' ? tool.input : null;
            const name = input && Reflect.get(input, 'nickname');
            const parent = input && Reflect.get(input, 'parentThreadId');
            const nickname = typeof name === 'string' ? name.trim() || null : null;
            const nativeParent = typeof parent === 'string' ? parent : null;
            const toolMessageRouteId = buildMessageRouteId(message);
            if (toolMessageRouteId) {
                anchors.push({
                    sidechainId, nickname, toolMessageRouteId, message,
                    parentSidechainId: nativeParent && nativeParent !== rootThreadId ? nativeParent : enclosingSidechainId,
                });
            }
            visit(message.children, sidechainId);
        }
    }
    visit(messages, null);
    return anchors;
}
