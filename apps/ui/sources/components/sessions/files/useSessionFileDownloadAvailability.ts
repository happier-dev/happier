import { useSessionFileTransferAvailability } from './useSessionFileTransferAvailability';

export function useSessionFileDownloadAvailability(sessionId: string): boolean {
    return useSessionFileTransferAvailability(sessionId);
}
