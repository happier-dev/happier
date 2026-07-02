import * as React from 'react';

import { DesktopPetOverlayRoute } from '@/components/pets/desktop/route/DesktopPetOverlayRoute';

export default function PetOverlayScreen(): React.ReactElement {
    return <DesktopPetOverlayRoute activitySource="native" />;
}
