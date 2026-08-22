/**
 * Compatibility seam for the existing committed-content writer. Generic plugin
 * transcript materialization is deferred, so this preserves the Message-owned
 * content exactly and cannot create a whole-content `pluginTranscriptV1` value.
 */
export async function materializeCommittedPluginStructuredMessageContent(params: Readonly<{
    sessionId: string;
    content: unknown;
}>): Promise<unknown> {
    void params.sessionId;
    return params.content;
}
