import { expect, it } from 'vitest';
import { withNativeComposeBuildFixture, withNativeComposeBuildAdmission } from './nativeComposeBuild.testkit';

it('builds a subdirectory Compose file with its relative context and context-relative Dockerfile', async () => {
    await withNativeComposeBuildFixture(async ({ project, readRuntimeProjection }) => {
        const { images } = await withNativeComposeBuildAdmission(project, context => project.prepareImages({ context,
            platforms: ['linux/amd64'], build: { noCacheServices: [], secretVariableNames: ['BUILD_SECRET'] } }));
        expect(images.map(image => image.service)).toEqual(['web', 'worker']);
        expect((await readRuntimeProjection({ images })).review.inspection).toBe('complete');
    }, { subdirectoryCompose: true });
});
