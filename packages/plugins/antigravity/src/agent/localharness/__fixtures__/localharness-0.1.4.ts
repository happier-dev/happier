// Derived from google-antigravity 0.1.4
// google/antigravity/connections/local/localharness_pb2.py
export const HANDSHAKE_FIXTURE = Object.freeze({
  distribution: 'google-antigravity',
  version: '0.1.4',
  descriptorSha256: 'e19c0670578bf891c96e470ed21cf2f6243f3983b559a3ae6d91236ce8c2f89d',
  descriptorLength: 11319,
  inputConfigPayloadHex: '0a00221c0a07686170706965721205302e302e301a0a74797065736372697074',
  inputConfigFrameHex: '200000000a00221c0a07686170706965721205302e302e301a0a74797065736372697074',
  outputConfigPayloadHex: '08f3d002120c6c6f6f706261636b2d6b6579',
  outputConfigFrameHex: '1200000008f3d002120c6c6f6f706261636b2d6b6579',
});

export const WEBSOCKET_FIXTURE = Object.freeze({
  initializeApiKey: {
    config: {
      models: [
        {
          name: 'gemini-3.5-flash',
          types: ['text'],
          geminiApiEndpoint: {
            apiKey: 'secret-api-key',
          },
        },
      ],
      harnessSideTools: {
        find: { enabled: true },
        runCommand: { enabled: true },
        userQuestions: { enabled: true },
        fileEdit: { enabled: true },
        viewFile: { enabled: true },
        writeToFile: { enabled: true },
        grepSearch: { enabled: true },
        listDir: { enabled: true },
        permissions: { enforceWorkspaceValidation: true },
      },
      workspaces: [
        { filesystemWorkspace: { directory: '/repo' } },
      ],
      mcpServers: [
        { name: 'fs', stdio: { command: 'server', args: ['--root', '/repo'] } },
        { name: 'docs', http: { url: 'https://example.test/mcp' } },
      ],
    },
  },
  startTurn: { userInput: 'hello' },
  cancel: { haltRequest: true },
  toolConfirmationResponse: {
    toolConfirmation: {
      trajectoryId: 'traj-1',
      stepIndex: 3,
      accepted: false,
    },
  },
  questionResponse: {
    questionResponse: {
      trajectoryId: 'traj-1',
      stepIndex: 4,
      response: {
        answers: [
          { multipleChoiceAnswer: { selectedChoiceIndices: [0] } },
        ],
      },
    },
  },
  toolResponse: {
    toolResponse: {
      id: 'call-1',
      responseJson: '{"error":"unsupported_client_tool"}',
    },
  },
  outputConversationStep: {
    stepUpdate: {
      cascadeId: 'conv-1',
      trajectoryId: 'traj-1',
      stepIndex: 1,
      state: 'STATE_ACTIVE',
      source: 'SOURCE_MODEL',
      target: 'TARGET_USER',
      textDelta: 'Hello',
      thinkingDelta: 'Plan',
    },
  },
  outputToolConfirmation: {
    stepUpdate: {
      trajectoryId: 'traj-1',
      stepIndex: 2,
      state: 'STATE_WAITING_FOR_USER',
      runCommand: {
        commandLine: 'ls',
        workingDir: '/repo',
      },
      requestText: 'Run command?',
      toolConfirmationRequest: {},
    },
  },
  outputQuestions: {
    stepUpdate: {
      trajectoryId: 'traj-1',
      stepIndex: 3,
      state: 'STATE_WAITING_FOR_USER',
      questionsRequest: {
        questions: [
          { multipleChoice: { question: 'Proceed?', choices: ['Yes', 'No'] } },
        ],
      },
    },
  },
  outputCustomTool: {
    toolCall: {
      id: 'call-1',
      name: 'client.custom',
      argumentsJson: '{"x":1}',
    },
  },
  outputMcpTool: {
    stepUpdate: {
      trajectoryId: 'traj-1',
      stepIndex: 5,
      state: 'STATE_ACTIVE',
      mcpTool: {
        serverName: 'fs',
        toolName: 'read',
        argumentsJson: '{"path":"a.txt"}',
      },
    },
  },
  outputUsage: {
    usageMetadata: {
      promptTokenCount: '3',
      candidatesTokenCount: '4',
      totalTokenCount: '7',
    },
  },
  outputIdle: {
    trajectoryStateUpdate: {
      trajectoryId: 'traj-1',
      state: 'STATE_IDLE',
    },
  },
});
