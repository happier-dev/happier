import { HomeConnectionDescriptorV1Schema, type HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';

export function homeConnectionDescriptorFixture(
    overrides: Partial<HomeConnectionDescriptorV1> = {},
): HomeConnectionDescriptorV1 {
    return HomeConnectionDescriptorV1Schema.parse({
        v: 1,
        homeServerIdentityId: 'srv_fixture_home',
        canonicalServerUrl: 'https://home.example.test',
        revision: 1,
        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
        ...overrides,
    });
}
