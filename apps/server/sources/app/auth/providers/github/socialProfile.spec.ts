import { describe, expect, it } from "vitest";

import { extractGitHubSocialProfile } from "./socialProfile";

describe("extractGitHubSocialProfile", () => {
    it("trims the suggested username and bio", () => {
        expect(
            extractGitHubSocialProfile({
                profile: { login: "  octocat  ", bio: "  hello world  " },
            }),
        ).toEqual({ suggestedUsername: "octocat", bio: "hello world" });
    });
});

