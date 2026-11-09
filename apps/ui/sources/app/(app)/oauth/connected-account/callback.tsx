import { ConnectedAccountOAuthCallbackPage } from '@/components/settings/connectedServices/setup/ConnectedAccountOAuthCallbackPage';

/** Public before sign-in; only the initiating daemon may exchange the authorization code. */
export default function ConnectedAccountOAuthCallbackRoute() {
    return <ConnectedAccountOAuthCallbackPage />;
}
