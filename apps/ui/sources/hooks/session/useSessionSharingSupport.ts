import { useEffect, useState } from 'react';
import { isSessionSharingSupported } from '@/sync/api/capabilities/apiFeatures';

export function useSessionSharingSupport(): boolean {
    const [supported, setSupported] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const next = await isSessionSharingSupported();
            if (cancelled) return;
            setSupported(next);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    return supported;
}

