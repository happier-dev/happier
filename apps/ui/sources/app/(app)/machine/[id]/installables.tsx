// A machine's tools are its Tools sub-page in the Machines doors; this 0.2-era route only leads there.
import { MachineLegacyRouteRedirect } from '@/components/machines/page/MachineLegacyRouteRedirect';

export default function MachineInstallablesLegacyRoute() {
    return <MachineLegacyRouteRedirect tab={{ id: 'setup', page: 'tools' }} />;
}
