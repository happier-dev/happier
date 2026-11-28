// Keep cross-app TypeScript aliases owned by their compiling app. The real
// source composition is typed by CLI and executed by UI's composed source lane.
export { exerciseMcpOAuthSocketRequestAuth, exerciseMcpOAuthMachineTest, prepareMcpOAuthSocketRequestAuthFixture,
    closeMcpOAuthSocketRequestAuthFixture } from './mcpOAuthSocketRequestAuth.composed.testkit.ts';
