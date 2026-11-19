/** @moduleRealm browser */
import './configureZodLocale.js';
import { installHostedWebPluginUiHostApiClientBootstrap, type HostedWebPluginUiClientRealm } from './hostedWebClientBootstrap.js';

// Browser MessagePort callbacks expose richer events than the portable realm
// contract; the bootstrap reads only its validated transport fields.
installHostedWebPluginUiHostApiClientBootstrap(window as unknown as HostedWebPluginUiClientRealm, { callerPresentation: true });
