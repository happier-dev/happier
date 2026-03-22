export {
    createOkFetchResponse,
    createRootLayoutFeaturesResponse,
} from '../fixtures/featureFixtures';

export function createRootLayoutFetchMock<T>(payload: T): typeof fetch {
    return (() => import('../fixtures/featureFixtures').then(({ createOkFetchResponse }) => createOkFetchResponse(payload))) as unknown as typeof fetch;
}
