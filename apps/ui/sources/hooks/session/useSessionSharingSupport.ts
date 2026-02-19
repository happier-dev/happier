import { useEffect, useState } from 'react';
import { isSessionSharingSupported } from '@/sync/api/capabilities/sessionSharingSupport';
import { fireAndForget } from '@/utils/system/fireAndForget';

export function useSessionSharingSupport(): boolean {
    const [supported, setSupported] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fireAndForget((async () => {
            const next = await isSessionSharingSupported();
            if (cancelled) return;
            setSupported(next);
        })(), { tag: 'useSessionSharingSupport.load' });
        return () => {
            cancelled = true;
        };
    }, []);

    return supported;
}
