/** @moduleRealm browser */
import './configureZodLocale.js';
import { installHostedWebPluginUiHostApiClientBootstrap, type HostedWebPluginUiClientRealm } from './hostedWebClientBootstrap.js';
import { installHappierHtmlKit, type HappierHtmlKitRealm } from './hostedHtmlKit.js';

// The host-styled kit reads the theme properties the caller presentation applies; it is
// installed first so a hosted page is styled even while its host connection is pending.
installHappierHtmlKit(window as unknown as HappierHtmlKitRealm);
// Browser MessagePort callbacks expose richer events than the portable realm
// contract; the bootstrap reads only its validated transport fields.
installHostedWebPluginUiHostApiClientBootstrap(window as unknown as HostedWebPluginUiClientRealm, { callerPresentation: true });
