import { ConnectedAccountOAuthCallbackPage } from '@/components/settings/connectedServices/setup/ConnectedAccountOAuthCallbackPage';
import { MCP_OAUTH_CALLBACK_PROTOCOL } from '@/sync/ops/connectedAccounts/mcpOAuthCallback';
import { t } from '@/text';

export function McpOAuthCallbackPage() {
    return <ConnectedAccountOAuthCallbackPage
        protocol={MCP_OAUTH_CALLBACK_PROTOCOL}
        testIdPrefix="mcp-oauth-callback"
        openConnectionsPath="/settings/mcp"
        invalidClientCopy={{ title: t('capabilities.mcpSignIn.invalidClientTitle'), body: t('capabilities.mcpSignIn.invalidClientBody') }}
        copy={{
            finishing: t('capabilities.mcpSignIn.callback.finishing'),
            closeTitle: t('capabilities.mcpSignIn.callback.closeTitle'),
            closeBody: t('capabilities.mcpSignIn.callback.closeBody'),
            connectedTitle: t('capabilities.mcpSignIn.callback.connectedTitle'),
            connectedBody: t('capabilities.mcpSignIn.callback.connectedBody'),
            pasteTitle: t('capabilities.mcpSignIn.callback.pasteTitle'),
            pasteBody: t('capabilities.mcpSignIn.callback.pasteBody'),
            copyCode: t('capabilities.mcpSignIn.callback.copyCode'),
            copied: t('capabilities.mcpSignIn.callback.copied'),
            invalidTitle: t('capabilities.mcpSignIn.callback.invalidTitle'),
            invalidBody: t('capabilities.mcpSignIn.callback.invalidBody'),
            unfinishedTitle: t('capabilities.mcpSignIn.callback.unfinishedTitle'),
            unfinishedBody: t('capabilities.mcpSignIn.callback.unfinishedBody'),
            openConnections: t('capabilities.mcpSignIn.callback.openServers'),
        }}
    />;
}
