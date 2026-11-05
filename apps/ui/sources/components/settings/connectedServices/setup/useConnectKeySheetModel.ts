import * as React from 'react';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { resolveConnectSheetOpening } from './connectSheetOpening';
import { useConnectSheetKeyBindingRefs } from './useConnectSheetKeyBindingRefs';
import type { ConnectSheetKeyRequest } from './ConnectedServiceSetupModal';

/** Opening uses metadata only; selecting/creating stays with the Saved Secret owner. */
export function useConnectKeySheetModel(request: ConnectSheetKeyRequest) {
    const catalog = useSavedSecretCatalog({ scope: request.scope, includeMaterial: false });
    const bindings = useConnectSheetKeyBindingRefs(request.bindingTarget, request.scope);
    const linkableEntries = React.useMemo(() => catalog.entries.filter(entry =>
        entry.name !== null && catalog.resolveReference(entry.ref).status === 'ready'),
    [catalog.entries, catalog.resolveReference]);
    const opening = resolveConnectSheetOpening(request, { keys: linkableEntries, sameTargetRefs: bindings.refs });
    return { catalog, linkableEntries: opening.savedKeys ?? [], initialMode: opening.initialMode,
        preselected: typeof opening.preselected === 'string' ? opening.preselected : null,
        // The body says why a row leads (in use here, used elsewhere for this); the order stays this owner's.
        sameTargetRefs: bindings.refs,
        loading: catalog.status === 'loading' || bindings.loading };
}
