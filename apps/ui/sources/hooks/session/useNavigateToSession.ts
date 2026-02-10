import { useRouter } from "expo-router"
import { getActiveServerSnapshot, setActiveServer } from "@/sync/domains/server/serverRuntime";

export function useNavigateToSession() {
    const router = useRouter();
    return (sessionId: string, opts?: Readonly<{ serverId?: string }>) => {
        const targetServerId = String(opts?.serverId ?? '').trim();
        if (targetServerId) {
            const active = String(getActiveServerSnapshot().serverId ?? '').trim();
            if (active && active !== targetServerId) {
                try {
                    setActiveServer({ serverId: targetServerId, scope: 'device' });
                } catch {
                    // If the profile is missing for some reason, still attempt navigation.
                }
            }
        }

        router.navigate(`/session/${sessionId}`, {
            dangerouslySingular(name, params) {
                return 'session'
            },
        });
    }
}
