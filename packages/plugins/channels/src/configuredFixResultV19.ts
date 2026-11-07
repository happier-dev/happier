import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { embedProtocolJsonSchema, ProtocolValidationError, type PluginJsonSchema, type ProtocolJsonValue,
    type ProtocolSchemaInput, type ProtocolSchemaOutput,
    type ProtocolSchemaSafeParseResult } from '@happier-dev/plugin-sdk/protocol';
import type { SessionMessageSendResultV1ProtocolSchema } from '@happier-dev/plugin-sdk/sessions';
import { SessionPullRequestConfiguredFixInputV1Schema } from '@happier-dev/channels-protocol/v1';
import { CONFIGURED_FIX_CAUSE_ACTION_IDS_V19 } from './configuredFixActionIdsV19.js';

type LiveResult = ProtocolSchemaInput<typeof SessionMessageSendResultV1ProtocolSchema>;
type LiveFanout = Extract<LiveResult, { kind: 'fanout' }>;
type LiveLeaf = LiveFanout['results'][number];
type LiveFailure = Extract<LiveLeaf['result'], { ok: false }>;
export type PersistedConfiguredFixFailureV19 = Omit<LiveFailure, 'failureCause'> & {
    cause?: LiveFailure['failureCause'];
};
type PersistedResultDtoV19 = Exclude<LiveResult, LiveFanout> | {
    kind: 'fanout';
    results: { target: LiveLeaf['target']; result: Exclude<LiveLeaf['result'], LiveFailure> | PersistedConfiguredFixFailureV19 }[];
};
export type PersistedConfiguredFixResultV19 = PersistedResultDtoV19 & ProtocolJsonValue;

/** Exact result document from the retained channel-state v19/fqhCh writer.
 * This persistence contract deliberately does not project a live SDK schema.
 * The type-only live references above check the translation at compile time;
 * they cannot change these stored bytes when the wire contract evolves. */
const RESULT_SCHEMA: PluginJsonSchema = {
  "anyOf": [
    {
      "anyOf": [
        {
          "oneOf": [
            {
              "oneOf": [
                {
                  "type": "object",
                  "required": [
                    "localId",
                    "status"
                  ],
                  "properties": {
                    "status": {
                      "type": "string",
                      "const": "accepted"
                    },
                    "localId": {
                      "type": "string"
                    }
                  },
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "required": [
                    "localId",
                    "status"
                  ],
                  "properties": {
                    "status": {
                      "type": "string",
                      "const": "alreadyAccepted"
                    },
                    "localId": {
                      "type": "string"
                    }
                  },
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "required": [
                    "code",
                    "status"
                  ],
                  "properties": {
                    "code": {
                      "enum": [
                        "model_not_granted",
                        "permission_mode_not_granted",
                        "session_input_archived",
                        "session_input_cancelled",
                        "session_input_encryption_mode_mismatch",
                        "session_input_idempotency_conflict",
                        "session_input_invalid",
                        "session_input_muted",
                        "session_input_permission_ceiling_rejected",
                        "session_input_source_authority_mismatch",
                        "session_input_storage_unavailable",
                        "session_input_target_unavailable",
                        "session_input_target_update_required",
                        "session_input_unauthorized",
                        "session_input_untrusted_assertion"
                      ],
                      "type": "string"
                    },
                    "status": {
                      "type": "string",
                      "const": "rejected"
                    }
                  },
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "required": [
                    "code",
                    "localId",
                    "status"
                  ],
                  "properties": {
                    "code": {
                      "type": "string"
                    },
                    "status": {
                      "type": "string",
                      "const": "outcomeUnknown"
                    },
                    "localId": {
                      "type": "string"
                    }
                  },
                  "additionalProperties": false
                }
              ]
            },
            {
              "type": "object",
              "required": [
                "code",
                "localId",
                "status"
              ],
              "properties": {
                "code": {
                  "enum": [
                    "autonomous_check_in",
                    "session_input_target_unavailable"
                  ],
                  "type": "string"
                },
                "status": {
                  "type": "string",
                  "const": "held"
                },
                "localId": {
                  "type": "string"
                }
              },
              "additionalProperties": false
            }
          ]
        },
        {
          "type": "object",
          "required": [
            "localId",
            "outcome",
            "status"
          ],
          "properties": {
            "status": {
              "type": "string",
              "const": "replied"
            },
            "localId": {
              "type": "string"
            },
            "outcome": {
              "anyOf": [
                {
                  "type": "object",
                  "required": [
                    "kind",
                    "messageRef",
                    "text"
                  ],
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "answer"
                    },
                    "text": {
                      "type": "string"
                    },
                    "messageRef": {
                      "type": "object",
                      "required": [
                        "kind",
                        "messageId",
                        "session"
                      ],
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "session"
                        },
                        "session": {
                          "type": "object",
                          "required": [
                            "serverId",
                            "sessionId"
                          ],
                          "properties": {
                            "serverId": {
                              "type": "string",
                              "minLength": 1
                            },
                            "sessionId": {
                              "type": "string",
                              "pattern": "^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])",
                              "maxLength": 191,
                              "minLength": 1
                            }
                          },
                          "additionalProperties": false
                        },
                        "messageId": {
                          "type": "string",
                          "minLength": 1
                        }
                      },
                      "additionalProperties": false
                    }
                  },
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "required": [
                    "kind",
                    "publicationRef"
                  ],
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "answer"
                    },
                    "publicationRef": {
                      "oneOf": [
                        {
                          "type": "object",
                          "required": [
                            "kind",
                            "messageId",
                            "session"
                          ],
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "session"
                            },
                            "session": {
                              "type": "object",
                              "required": [
                                "serverId",
                                "sessionId"
                              ],
                              "properties": {
                                "serverId": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "sessionId": {
                                  "type": "string",
                                  "pattern": "^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])",
                                  "maxLength": 191,
                                  "minLength": 1
                                }
                              },
                              "additionalProperties": false
                            },
                            "messageId": {
                              "type": "string",
                              "minLength": 1
                            }
                          },
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "required": [
                            "discussion",
                            "kind",
                            "messageId"
                          ],
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "discussion"
                            },
                            "messageId": {
                              "type": "string",
                              "pattern": "^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])",
                              "maxLength": 191,
                              "minLength": 1
                            },
                            "discussion": {
                              "type": "object",
                              "required": [
                                "discussionId",
                                "serverId"
                              ],
                              "properties": {
                                "serverId": {
                                  "type": "string",
                                  "pattern": "^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])",
                                  "minLength": 1
                                },
                                "discussionId": {
                                  "type": "string",
                                  "pattern": "^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])",
                                  "maxLength": 191,
                                  "minLength": 1
                                }
                              },
                              "additionalProperties": false
                            }
                          },
                          "additionalProperties": false
                        }
                      ]
                    }
                  },
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "required": [
                    "kind",
                    "messageRef",
                    "partialText"
                  ],
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "cancelled"
                    },
                    "messageRef": {
                      "type": "object",
                      "required": [
                        "kind",
                        "messageId",
                        "session"
                      ],
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "session"
                        },
                        "session": {
                          "type": "object",
                          "required": [
                            "serverId",
                            "sessionId"
                          ],
                          "properties": {
                            "serverId": {
                              "type": "string",
                              "minLength": 1
                            },
                            "sessionId": {
                              "type": "string",
                              "pattern": "^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])",
                              "maxLength": 191,
                              "minLength": 1
                            }
                          },
                          "additionalProperties": false
                        },
                        "messageId": {
                          "type": "string",
                          "minLength": 1
                        }
                      },
                      "additionalProperties": false
                    },
                    "partialText": {
                      "type": "string"
                    }
                  },
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "required": [
                    "kind"
                  ],
                  "properties": {
                    "kind": {
                      "enum": [
                        "cancelled",
                        "declined",
                        "failed",
                        "pass",
                        "terminal_no_result"
                      ],
                      "type": "string"
                    }
                  },
                  "additionalProperties": false
                }
              ]
            },
            "inputMessageRef": {
              "type": "object",
              "required": [
                "kind",
                "messageId",
                "session"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "session"
                },
                "session": {
                  "type": "object",
                  "required": [
                    "serverId",
                    "sessionId"
                  ],
                  "properties": {
                    "serverId": {
                      "type": "string",
                      "minLength": 1
                    },
                    "sessionId": {
                      "type": "string",
                      "pattern": "^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])",
                      "maxLength": 191,
                      "minLength": 1
                    }
                  },
                  "additionalProperties": false
                },
                "messageId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "additionalProperties": false
            }
          },
          "additionalProperties": false
        },
        {
          "type": "object",
          "required": [
            "code",
            "localId",
            "status"
          ],
          "properties": {
            "code": {
              "type": "string",
              "const": "session_input_turn_failed"
            },
            "status": {
              "type": "string",
              "const": "failed"
            },
            "localId": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        {
          "type": "object",
          "required": [
            "code",
            "localId",
            "status"
          ],
          "properties": {
            "code": {
              "type": "string",
              "const": "session_input_turn_cancelled"
            },
            "status": {
              "type": "string",
              "const": "cancelled"
            },
            "localId": {
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      ]
    },
    {
      "type": "object",
      "required": [
        "kind",
        "results"
      ],
      "properties": {
        "kind": {
          "type": "string",
          "const": "fanout"
        },
        "results": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "result",
              "target"
            ],
            "properties": {
              "result": {
                "anyOf": [
                  {
                    "type": "object",
                    "required": [
                      "ok",
                      "result"
                    ],
                    "properties": {
                      "ok": {
                        "type": "boolean",
                        "const": true
                      },
                      "result": {
                        "anyOf": [
                          {
                            "oneOf": [
                              {
                                "oneOf": [
                                  {
                                    "type": "object",
                                    "required": [
                                      "localId",
                                      "status"
                                    ],
                                    "properties": {
                                      "status": {
                                        "type": "string",
                                        "const": "accepted"
                                      },
                                      "localId": {
                                        "type": "string"
                                      }
                                    },
                                    "additionalProperties": false
                                  },
                                  {
                                    "type": "object",
                                    "required": [
                                      "localId",
                                      "status"
                                    ],
                                    "properties": {
                                      "status": {
                                        "type": "string",
                                        "const": "alreadyAccepted"
                                      },
                                      "localId": {
                                        "type": "string"
                                      }
                                    },
                                    "additionalProperties": false
                                  },
                                  {
                                    "type": "object",
                                    "required": [
                                      "code",
                                      "status"
                                    ],
                                    "properties": {
                                      "code": {
                                        "enum": [
                                          "model_not_granted",
                                          "permission_mode_not_granted",
                                          "session_input_archived",
                                          "session_input_cancelled",
                                          "session_input_encryption_mode_mismatch",
                                          "session_input_idempotency_conflict",
                                          "session_input_invalid",
                                          "session_input_muted",
                                          "session_input_permission_ceiling_rejected",
                                          "session_input_source_authority_mismatch",
                                          "session_input_storage_unavailable",
                                          "session_input_target_unavailable",
                                          "session_input_target_update_required",
                                          "session_input_unauthorized",
                                          "session_input_untrusted_assertion"
                                        ],
                                        "type": "string"
                                      },
                                      "status": {
                                        "type": "string",
                                        "const": "rejected"
                                      }
                                    },
                                    "additionalProperties": false
                                  },
                                  {
                                    "type": "object",
                                    "required": [
                                      "code",
                                      "localId",
                                      "status"
                                    ],
                                    "properties": {
                                      "code": {
                                        "type": "string"
                                      },
                                      "status": {
                                        "type": "string",
                                        "const": "outcomeUnknown"
                                      },
                                      "localId": {
                                        "type": "string"
                                      }
                                    },
                                    "additionalProperties": false
                                  }
                                ]
                              },
                              {
                                "type": "object",
                                "required": [
                                  "code",
                                  "localId",
                                  "status"
                                ],
                                "properties": {
                                  "code": {
                                    "enum": [
                                      "autonomous_check_in",
                                      "session_input_target_unavailable"
                                    ],
                                    "type": "string"
                                  },
                                  "status": {
                                    "type": "string",
                                    "const": "held"
                                  },
                                  "localId": {
                                    "type": "string"
                                  }
                                },
                                "additionalProperties": false
                              }
                            ]
                          },
                          {
                            "type": "object",
                            "required": [
                              "localId",
                              "outcome",
                              "status"
                            ],
                            "properties": {
                              "status": {
                                "type": "string",
                                "const": "replied"
                              },
                              "localId": {
                                "type": "string"
                              },
                              "outcome": {
                                "anyOf": [
                                  {
                                    "type": "object",
                                    "required": [
                                      "kind",
                                      "messageRef",
                                      "text"
                                    ],
                                    "properties": {
                                      "kind": {
                                        "type": "string",
                                        "const": "answer"
                                      },
                                      "text": {
                                        "type": "string"
                                      },
                                      "messageRef": {
                                        "type": "object",
                                        "required": [
                                          "kind",
                                          "messageId",
                                          "session"
                                        ],
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "session"
                                          },
                                          "session": {
                                            "type": "object",
                                            "required": [
                                              "serverId",
                                              "sessionId"
                                            ],
                                            "properties": {
                                              "serverId": {
                                                "type": "string",
                                                "minLength": 1
                                              },
                                              "sessionId": {
                                                "type": "string",
                                                "pattern": "^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])",
                                                "maxLength": 191,
                                                "minLength": 1
                                              }
                                            },
                                            "additionalProperties": false
                                          },
                                          "messageId": {
                                            "type": "string",
                                            "minLength": 1
                                          }
                                        },
                                        "additionalProperties": false
                                      }
                                    },
                                    "additionalProperties": false
                                  },
                                  {
                                    "type": "object",
                                    "required": [
                                      "kind",
                                      "publicationRef"
                                    ],
                                    "properties": {
                                      "kind": {
                                        "type": "string",
                                        "const": "answer"
                                      },
                                      "publicationRef": {
                                        "oneOf": [
                                          {
                                            "type": "object",
                                            "required": [
                                              "kind",
                                              "messageId",
                                              "session"
                                            ],
                                            "properties": {
                                              "kind": {
                                                "type": "string",
                                                "const": "session"
                                              },
                                              "session": {
                                                "type": "object",
                                                "required": [
                                                  "serverId",
                                                  "sessionId"
                                                ],
                                                "properties": {
                                                  "serverId": {
                                                    "type": "string",
                                                    "minLength": 1
                                                  },
                                                  "sessionId": {
                                                    "type": "string",
                                                    "pattern": "^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])",
                                                    "maxLength": 191,
                                                    "minLength": 1
                                                  }
                                                },
                                                "additionalProperties": false
                                              },
                                              "messageId": {
                                                "type": "string",
                                                "minLength": 1
                                              }
                                            },
                                            "additionalProperties": false
                                          },
                                          {
                                            "type": "object",
                                            "required": [
                                              "discussion",
                                              "kind",
                                              "messageId"
                                            ],
                                            "properties": {
                                              "kind": {
                                                "type": "string",
                                                "const": "discussion"
                                              },
                                              "messageId": {
                                                "type": "string",
                                                "pattern": "^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])",
                                                "maxLength": 191,
                                                "minLength": 1
                                              },
                                              "discussion": {
                                                "type": "object",
                                                "required": [
                                                  "discussionId",
                                                  "serverId"
                                                ],
                                                "properties": {
                                                  "serverId": {
                                                    "type": "string",
                                                    "pattern": "^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])",
                                                    "minLength": 1
                                                  },
                                                  "discussionId": {
                                                    "type": "string",
                                                    "pattern": "^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])",
                                                    "maxLength": 191,
                                                    "minLength": 1
                                                  }
                                                },
                                                "additionalProperties": false
                                              }
                                            },
                                            "additionalProperties": false
                                          }
                                        ]
                                      }
                                    },
                                    "additionalProperties": false
                                  },
                                  {
                                    "type": "object",
                                    "required": [
                                      "kind",
                                      "messageRef",
                                      "partialText"
                                    ],
                                    "properties": {
                                      "kind": {
                                        "type": "string",
                                        "const": "cancelled"
                                      },
                                      "messageRef": {
                                        "type": "object",
                                        "required": [
                                          "kind",
                                          "messageId",
                                          "session"
                                        ],
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "session"
                                          },
                                          "session": {
                                            "type": "object",
                                            "required": [
                                              "serverId",
                                              "sessionId"
                                            ],
                                            "properties": {
                                              "serverId": {
                                                "type": "string",
                                                "minLength": 1
                                              },
                                              "sessionId": {
                                                "type": "string",
                                                "pattern": "^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])",
                                                "maxLength": 191,
                                                "minLength": 1
                                              }
                                            },
                                            "additionalProperties": false
                                          },
                                          "messageId": {
                                            "type": "string",
                                            "minLength": 1
                                          }
                                        },
                                        "additionalProperties": false
                                      },
                                      "partialText": {
                                        "type": "string"
                                      }
                                    },
                                    "additionalProperties": false
                                  },
                                  {
                                    "type": "object",
                                    "required": [
                                      "kind"
                                    ],
                                    "properties": {
                                      "kind": {
                                        "enum": [
                                          "cancelled",
                                          "declined",
                                          "failed",
                                          "pass",
                                          "terminal_no_result"
                                        ],
                                        "type": "string"
                                      }
                                    },
                                    "additionalProperties": false
                                  }
                                ]
                              },
                              "inputMessageRef": {
                                "type": "object",
                                "required": [
                                  "kind",
                                  "messageId",
                                  "session"
                                ],
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "session"
                                  },
                                  "session": {
                                    "type": "object",
                                    "required": [
                                      "serverId",
                                      "sessionId"
                                    ],
                                    "properties": {
                                      "serverId": {
                                        "type": "string",
                                        "minLength": 1
                                      },
                                      "sessionId": {
                                        "type": "string",
                                        "pattern": "^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])",
                                        "maxLength": 191,
                                        "minLength": 1
                                      }
                                    },
                                    "additionalProperties": false
                                  },
                                  "messageId": {
                                    "type": "string",
                                    "minLength": 1
                                  }
                                },
                                "additionalProperties": false
                              }
                            },
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "required": [
                              "code",
                              "localId",
                              "status"
                            ],
                            "properties": {
                              "code": {
                                "type": "string",
                                "const": "session_input_turn_failed"
                              },
                              "status": {
                                "type": "string",
                                "const": "failed"
                              },
                              "localId": {
                                "type": "string"
                              }
                            },
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "required": [
                              "code",
                              "localId",
                              "status"
                            ],
                            "properties": {
                              "code": {
                                "type": "string",
                                "const": "session_input_turn_cancelled"
                              },
                              "status": {
                                "type": "string",
                                "const": "cancelled"
                              },
                              "localId": {
                                "type": "string"
                              }
                            },
                            "additionalProperties": false
                          }
                        ]
                      }
                    },
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "required": [
                      "error",
                      "errorCode",
                      "ok"
                    ],
                    "properties": {
                      "ok": {
                        "type": "boolean",
                        "const": false
                      },
                      "cause": {
                        "type": "object",
                        "required": [
                          "errorClass",
                          "errorCode",
                          "httpStatus",
                          "phase"
                        ],
                        "properties": {
                          "phase": {
                            "anyOf": [
                              {
                                "type": "string",
                                "const": "dispatch"
                              },
                              {
                                "enum": CONFIGURED_FIX_CAUSE_ACTION_IDS_V19,
                                "type": "string"
                              },
                              {
                                "type": "string",
                                "pattern": "^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+$"
                              }
                            ]
                          },
                          "errorCode": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "errorClass": {
                            "enum": [
                              "$ZodError",
                              "AbortError",
                              "AxiosError",
                              "Error",
                              "HttpStatusError",
                              "JsonRpcApplicationError",
                              "ManagedMachineControllerError",
                              "ManagedMachineError",
                              "PrismaClientInitializationError",
                              "PrismaClientKnownRequestError",
                              "PrismaClientUnknownRequestError",
                              "PrismaClientValidationError",
                              "RangeError",
                              "RpcError",
                              "SyntaxError",
                              "TransactionAcquisitionUnavailableError",
                              "TransactionConflictExhaustedError",
                              "TransactionDeadlineExceededError",
                              "TypeError",
                              "UnknownThrownValue",
                              "ZodError"
                            ],
                            "type": "string"
                          },
                          "httpStatus": {
                            "anyOf": [
                              {
                                "type": "integer",
                                "maximum": 599,
                                "minimum": 100
                              },
                              {
                                "type": "null"
                              }
                            ]
                          }
                        },
                        "additionalProperties": false
                      },
                      "error": {
                        "type": "string",
                        "minLength": 1
                      },
                      "details": {},
                      "errorCode": {
                        "type": "string",
                        "minLength": 1
                      },
                      "effectAttempted": {
                        "type": "boolean"
                      },
                      "goalControlFailure": {
                        "type": "object",
                        "required": [
                          "phase"
                        ],
                        "properties": {
                          "phase": {
                            "enum": [
                              "host_publication_rejected",
                              "missing_matching_publication",
                              "native_effect",
                              "provider_completion",
                              "tail_drain"
                            ],
                            "type": "string"
                          }
                        },
                        "additionalProperties": false
                      }
                    },
                    "additionalProperties": false
                  }
                ]
              },
              "target": {
                "type": "object",
                "required": [
                  "serverId",
                  "sessionId"
                ],
                "properties": {
                  "serverId": {
                    "type": "string",
                    "minLength": 1
                  },
                  "sessionId": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "additionalProperties": false
              }
            },
            "additionalProperties": false
          }
        }
      },
      "additionalProperties": false
    }
  ]
};

// The enclosing composable object previously embedded its child's projection
// without the document dialect. Retain that exact v19 document structure.
const { $schema: _requestDialect, ...requestSchema } = SessionPullRequestConfiguredFixInputV1Schema.jsonSchema;
const jsonSchema: PluginJsonSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#', type: 'object',
    properties: { kind: { const: 'configuredFix' },
        request: embedProtocolJsonSchema(requestSchema, ['properties', 'request']), result: RESULT_SCHEMA },
    required: ['kind', 'request'], additionalProperties: false,
};
type ConfiguredFixCustodyV19 = {
    kind: 'configuredFix';
    request: ProtocolSchemaOutput<typeof SessionPullRequestConfiguredFixInputV1Schema>;
    result?: PersistedConfiguredFixResultV19;
};
const validateCustody = compilePluginJsonSchema(jsonSchema);
function isConfiguredFixCustody(value: unknown): value is ConfiguredFixCustodyV19 {
    return isValidPluginJsonSchemaValue(validateCustody, value);
}
function safeParse(value: unknown): ProtocolSchemaSafeParseResult<ConfiguredFixCustodyV19> {
    return isConfiguredFixCustody(value) ? { success: true, data: value } : {
        success: false, error: new ProtocolValidationError([
            { code: 'invalid_json_value', path: [], message: 'Invalid stored configured Fix custody.' },
        ]),
    };
}
export const SessionPullRequestConfiguredFixCustodySchema = {
    jsonSchema, safeParse,
    parse(value: unknown): ConfiguredFixCustodyV19 {
        const parsed = safeParse(value);
        if (!parsed.success) throw parsed.error;
        return parsed.data;
    },
};

export function persistConfiguredFixResultV19(parsed: ProtocolSchemaOutput<typeof SessionMessageSendResultV1ProtocolSchema>): PersistedConfiguredFixResultV19 {
    const result: LiveResult = parsed;
    const persisted: PersistedResultDtoV19 = !('kind' in result) ? result : { kind: result.kind, results: result.results.map(({ target, result: leaf }) => {
        if (leaf.ok) return { target, result: leaf };
        const { failureCause, ...failure } = leaf;
        return { target, result: { ...failure, ...(failureCause === undefined ? {} : { cause: failureCause }) } };
    }) };
    // Renaming one key preserves the live parser's strict-JSON guarantee.
    return persisted as PersistedConfiguredFixResultV19;
}

export function restoreConfiguredFixResultV19(parsed: PersistedConfiguredFixResultV19): ProtocolSchemaOutput<typeof SessionMessageSendResultV1ProtocolSchema> {
    const result: PersistedResultDtoV19 = parsed;
    const live: LiveResult = !('kind' in result) ? result : { kind: result.kind, results: result.results.map(({ target, result: leaf }) => {
        if (leaf.ok) return { target, result: leaf };
        const { cause, ...failure } = leaf;
        return { target, result: { ...failure, ...(cause === undefined ? {} : { failureCause: cause }) } };
    }) };
    // The stored validator proved strict JSON; the inverse key rename preserves it.
    return live as ProtocolSchemaOutput<typeof SessionMessageSendResultV1ProtocolSchema>;
}

/** Fanout uncertainty belongs to its accepted leaves, not to the wrapper. */
export function isConfiguredFixResultUncertain(result: LiveResult): boolean {
    return 'kind' in result
        ? result.results.some(({ result: leaf }) => leaf.ok && leaf.result.status === 'outcomeUnknown')
        : result.status === 'outcomeUnknown';
}
