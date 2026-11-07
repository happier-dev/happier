import { afterEach, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { ExternalSessionFollowFailureError } from './externalSessionFollowFailure';
import { reportExternalSessionFollowAcquisitionFailure } from './followFailureDiagnostic';

afterEach(() => vi.restoreAllMocks());

it.each(['follow_transcript_reads_unavailable', 'follow_live_observation_unavailable', 'follow_observer_not_observing'] as const)(
    'retains the closed host refusal cause %s without exception content', code => {
        const logged = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const error = new ExternalSessionFollowFailureError('follow_unavailable', 'private exception content', code);
        const result = reportExternalSessionFollowAcquisitionFailure({ error, code: 'plugin_external_follow_unavailable', phase: 'admission' });
        expect(result.details).toMatchObject({ cause: { errorClass: 'ExternalSessionFollowFailureError', errorCode: code } });
        expect(JSON.stringify(logged.mock.calls)).not.toContain('private exception content');
    },
);
