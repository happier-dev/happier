import * as React from 'react';

import { invokeTauri, isTauriDesktop } from '@/utils/platform/tauri';

type DesktopAutostartState = Readonly<{
    supported: boolean;
    enabled: boolean;
    loading: boolean;
    error: string | null;
    setEnabled: (enabled: boolean) => Promise<void>;
}>;

export function useDesktopAutostart(): DesktopAutostartState {
    const supported = React.useMemo(() => isTauriDesktop(), []);
    const [enabled, setEnabledState] = React.useState(false);
    const [loading, setLoading] = React.useState(supported);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (!supported) {
            setLoading(false);
            return;
        }

        let cancelled = false;
        setLoading(true);
        setError(null);

        void invokeTauri<boolean>('desktop_get_autostart_enabled')
            .then((value) => {
                if (cancelled) {
                    return;
                }
                setEnabledState(Boolean(value));
            })
            .catch((nextError) => {
                if (cancelled) {
                    return;
                }
                setError(String((nextError as Error | undefined)?.message ?? nextError ?? 'Unknown error'));
            })
            .finally(() => {
                if (!cancelled) {
                    setLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [supported]);

    const setEnabled = React.useCallback(async (nextEnabled: boolean) => {
        if (!supported) {
            return;
        }

        setLoading(true);
        setError(null);
        try {
            const actualEnabled = await invokeTauri<boolean>('desktop_set_autostart_enabled', {
                enabled: nextEnabled,
            });
            setEnabledState(Boolean(actualEnabled));
        } catch (nextError) {
            setError(String((nextError as Error | undefined)?.message ?? nextError ?? 'Unknown error'));
        } finally {
            setLoading(false);
        }
    }, [supported]);

    return {
        supported,
        enabled,
        loading,
        error,
        setEnabled,
    };
}
