import * as React from 'react';
import { View, Text, ScrollView, Pressable, TextInput, Platform } from 'react-native';
import { Typography } from '@/constants/Typography';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/icons/Icon';

type InputStyle = {
    id: string;
    name: string;
    description: string;
    preview: React.ReactNode;
};

export default function InputStylesDemo() {
    const [selectedStyle, setSelectedStyle] = React.useState('slack');
    const safeArea = useSafeAreaInsets();

    // Define all input style variants
    const inputStyles: InputStyle[] = [
        {
            id: 'slack',
            name: 'Slack Style',
            description: 'Minimalist with icon-only buttons',
            preview: (
                <View style={{ backgroundColor: '#fff' }}>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 12,
                        paddingTop: 8,
                        paddingBottom: 4,
                    }}>
                        <Pressable style={{ padding: 6, marginRight: 2 }}>
                            <Icon name="at" size={16} color="#666" />
                        </Pressable>
                        <Pressable style={{ padding: 6, marginRight: 2 }}>
                            <Icon name="smiley" size={16} color="#666" />
                        </Pressable>
                        <Pressable style={{ padding: 6, marginRight: 2 }}>
                            <Icon name="text-b" size={16} color="#666" />
                        </Pressable>
                        <Pressable style={{ padding: 6, marginRight: 2 }}>
                            <Icon name="text-italic" size={16} color="#666" />
                        </Pressable>
                        <Pressable style={{ padding: 6, marginRight: 2 }}>
                            <Icon name="link" size={16} color="#666" />
                        </Pressable>
                        <View style={{ flex: 1 }} />
                        <Pressable style={{ padding: 6 }}>
                            <Icon name="code" size={16} color="#666" />
                        </Pressable>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'flex-end',
                        paddingHorizontal: 12,
                        paddingBottom: 12,
                    }}>
                        <Pressable style={{ padding: 8 }}>
                            <Icon name="plus" size={20} color="#666" />
                        </Pressable>
                        <View style={{
                            flex: 1,
                            flexDirection: 'row',
                            alignItems: 'center',
                            backgroundColor: '#f8f8f8',
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: '#e0e0e0',
                            paddingHorizontal: 12,
                            marginHorizontal: 8,
                            height: 36,
                        }}>
                            <TextInput
                                style={{ flex: 1, fontSize: 14, color: '#333' }}
                                placeholder="Message"
                                placeholderTextColor="#999"
                                editable={false}
                            />
                        </View>
                        <Pressable style={{ padding: 8 }}>
                            <Icon name="paper-plane-tilt" size={16} color="#007a5a" />
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'openai',
            name: 'OpenAI Style',
            description: 'Clean with subtle rounded corners',
            preview: (
                <View style={{ backgroundColor: '#fff' }}>
                    <View style={{ padding: 16 }}>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            backgroundColor: '#f7f7f8',
                            borderRadius: 24,
                            borderWidth: 1,
                            borderColor: '#e5e5e5',
                            paddingLeft: 16,
                            paddingRight: 4,
                            minHeight: 48,
                        }}>
                            <TextInput
                                style={{ flex: 1, fontSize: 16, color: '#000', paddingVertical: 12 }}
                                placeholder="Message ChatGPT..."
                                placeholderTextColor="#8e8e8e"
                                editable={false}
                            />
                            <Pressable style={{
                                width: 40,
                                height: 40,
                                borderRadius: 20,
                                backgroundColor: '#000',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}>
                                <Icon name="arrow-up" size={20} color="#fff" />
                            </Pressable>
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 20,
                        paddingBottom: 12,
                    }}>
                        <Pressable style={{
                            paddingHorizontal: 14,
                            paddingVertical: 6,
                            borderRadius: 16,
                            backgroundColor: '#f0f0f0',
                            marginRight: 8,
                        }}>
                            <Icon name="paperclip" size={16} color="#666" />
                        </Pressable>
                        <Pressable style={{
                            paddingHorizontal: 14,
                            paddingVertical: 6,
                            borderRadius: 16,
                            backgroundColor: '#f0f0f0',
                            marginRight: 8,
                        }}>
                            <Icon name="image" size={16} color="#666" />
                        </Pressable>
                        <Pressable style={{
                            paddingHorizontal: 14,
                            paddingVertical: 6,
                            borderRadius: 16,
                            backgroundColor: '#f0f0f0',
                        }}>
                            <Text style={{ fontSize: 13, color: '#666' }}>GPT-4</Text>
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'discord',
            name: 'Discord Style',
            description: 'Dark mode with attachment button',
            preview: (
                <View style={{ backgroundColor: '#36393f' }}>
                    <View style={{ padding: 16 }}>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            backgroundColor: '#40444b',
                            borderRadius: 8,
                            paddingHorizontal: 16,
                            minHeight: 44,
                        }}>
                            <Pressable style={{ marginRight: 16 }}>
                                <Icon name="plus-circle" size={24} color="#b9bbbe" />
                            </Pressable>
                            <TextInput
                                style={{ flex: 1, fontSize: 16, color: '#dcddde' }}
                                placeholder="Message #general"
                                placeholderTextColor="#72767d"
                                editable={false}
                            />
                            <Pressable style={{ marginLeft: 12 }}>
                                <Icon name="gif" size={24} color="#b9bbbe" />
                            </Pressable>
                            <Pressable style={{ marginLeft: 12 }}>
                                <Icon name="smiley" size={24} color="#b9bbbe" />
                            </Pressable>
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 20,
                        paddingBottom: 12,
                    }}>
                        <Pressable style={{ padding: 4, marginRight: 8 }}>
                            <Icon name="gift" size={16} color="#b9bbbe" />
                        </Pressable>
                        <Pressable style={{ padding: 4, marginRight: 8 }}>
                            <Icon name="note" size={16} color="#b9bbbe" />
                        </Pressable>
                        <Pressable style={{ padding: 4 }}>
                            <Icon name="game-controller" size={16} color="#b9bbbe" />
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'whatsapp',
            name: 'WhatsApp Style',
            description: 'Green accents with circular buttons',
            preview: (
                <View style={{ backgroundColor: '#e5ddd5' }}>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'flex-end',
                        padding: 8,
                    }}>
                        <View style={{
                            flex: 1,
                            flexDirection: 'row',
                            alignItems: 'center',
                            backgroundColor: '#fff',
                            borderRadius: 25,
                            paddingHorizontal: 12,
                            marginRight: 8,
                            minHeight: 42,
                        }}>
                            <Pressable style={{ marginRight: 8 }}>
                                <Icon name="smiley" size={24} color="#51585c" />
                            </Pressable>
                            <TextInput
                                style={{ flex: 1, fontSize: 16, color: '#000' }}
                                placeholder="Type a message"
                                placeholderTextColor="#999"
                                editable={false}
                            />
                            <Pressable style={{ marginLeft: 8 }}>
                                <Icon name="paperclip" size={24} color="#51585c" />
                            </Pressable>
                            <Pressable style={{ marginLeft: 8 }}>
                                <Icon name="camera" size={24} color="#51585c" />
                            </Pressable>
                        </View>
                        <Pressable style={{
                            width: 48,
                            height: 48,
                            borderRadius: 24,
                            backgroundColor: '#25d366',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}>
                            <Icon name="microphone" size={24} color="#fff" />
                        </Pressable>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 12,
                        paddingBottom: 8,
                    }}>
                        <Pressable style={{
                            paddingHorizontal: 12,
                            paddingVertical: 4,
                            backgroundColor: 'rgba(0,0,0,0.05)',
                            borderRadius: 12,
                            marginRight: 6,
                        }}>
                            <Text style={{ fontSize: 12, color: '#667781' }}>Photo</Text>
                        </Pressable>
                        <Pressable style={{
                            paddingHorizontal: 12,
                            paddingVertical: 4,
                            backgroundColor: 'rgba(0,0,0,0.05)',
                            borderRadius: 12,
                            marginRight: 6,
                        }}>
                            <Text style={{ fontSize: 12, color: '#667781' }}>Video</Text>
                        </Pressable>
                        <Pressable style={{
                            paddingHorizontal: 12,
                            paddingVertical: 4,
                            backgroundColor: 'rgba(0,0,0,0.05)',
                            borderRadius: 12,
                        }}>
                            <Text style={{ fontSize: 12, color: '#667781' }}>Document</Text>
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'telegram',
            name: 'Telegram Style',
            description: 'Flat design with sharp corners',
            preview: (
                <View style={{ backgroundColor: '#fff' }}>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        padding: 8,
                        borderTopWidth: 1,
                        borderTopColor: '#e0e0e0',
                    }}>
                        <Pressable style={{ padding: 8 }}>
                            <Icon name="paperclip" size={24} color="#8e8e8e" />
                        </Pressable>
                        <View style={{
                            flex: 1,
                            backgroundColor: '#f0f0f0',
                            borderRadius: 18,
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            marginHorizontal: 8,
                        }}>
                            <TextInput
                                style={{ fontSize: 16, color: '#000' }}
                                placeholder="Message"
                                placeholderTextColor="#999"
                                editable={false}
                            />
                        </View>
                        <Pressable style={{ padding: 8 }}>
                            <Icon name="microphone" size={24} color="#0088cc" />
                        </Pressable>
                        <Pressable style={{
                            padding: 8,
                            backgroundColor: '#0088cc',
                            borderRadius: 20,
                        }}>
                            <Icon name="paper-plane-tilt" size={20} color="#fff" />
                        </Pressable>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 16,
                        paddingBottom: 8,
                    }}>
                        <Pressable style={{ padding: 4, marginRight: 12 }}>
                            <Icon name="smiley" size={20} color="#8e8e8e" />
                        </Pressable>
                        <Pressable style={{ padding: 4, marginRight: 12 }}>
                            <Icon name="note" size={20} color="#8e8e8e" />
                        </Pressable>
                        <Pressable style={{ padding: 4, marginRight: 12 }}>
                            <Icon name="map-pin" size={20} color="#8e8e8e" />
                        </Pressable>
                        <Pressable style={{ padding: 4 }}>
                            <Icon name="timer" size={20} color="#8e8e8e" />
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'linear',
            name: 'Linear Style',
            description: 'Modern with subtle gradients',
            preview: (
                <View style={{ backgroundColor: '#fcfcfc' }}>
                    <View style={{ padding: 16 }}>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            backgroundColor: '#fff',
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: '#e1e4e8',
                            paddingLeft: 16,
                            paddingRight: 8,
                            minHeight: 42,
                        }}>
                            <TextInput
                                style={{ flex: 1, fontSize: 15, color: '#24292e' }}
                                placeholder="Add a comment..."
                                placeholderTextColor="#6a737d"
                                editable={false}
                            />
                            <Pressable style={{
                                paddingHorizontal: 16,
                                paddingVertical: 6,
                                backgroundColor: '#5e6ad2',
                                borderRadius: 6,
                            }}>
                                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>
                                    Comment
                                </Text>
                            </Pressable>
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 20,
                        paddingBottom: 12,
                    }}>
                        <Pressable style={{ marginRight: 16 }}>
                            <Icon name="at" size={16} color="#6a737d" />
                        </Pressable>
                        <Pressable style={{ marginRight: 16 }}>
                            <Icon name="tag" size={16} color="#6a737d" />
                        </Pressable>
                        <Pressable style={{ marginRight: 16 }}>
                            <Icon name="code" size={16} color="#6a737d" />
                        </Pressable>
                        <Pressable>
                            <Icon name="paperclip" size={16} color="#6a737d" />
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'notion',
            name: 'Notion Style',
            description: 'Minimal with "/" command hint',
            preview: (
                <View style={{ backgroundColor: '#fff' }}>
                    <View style={{ padding: 16 }}>
                        <View style={{
                            borderRadius: 3,
                            borderWidth: 1,
                            borderColor: 'rgba(55, 53, 47, 0.16)',
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                        }}>
                            <TextInput
                                style={{ fontSize: 16, color: '#37352f' }}
                                placeholder="Type '/' for commands"
                                placeholderTextColor="rgba(55, 53, 47, 0.4)"
                                editable={false}
                            />
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 20,
                        paddingBottom: 12,
                    }}>
                        <Pressable style={{
                            paddingHorizontal: 10,
                            paddingVertical: 4,
                            backgroundColor: '#f7f6f3',
                            borderRadius: 3,
                            marginRight: 8,
                        }}>
                            <Text style={{ fontSize: 12, color: '#787774' }}>Add icon</Text>
                        </Pressable>
                        <Pressable style={{
                            paddingHorizontal: 10,
                            paddingVertical: 4,
                            backgroundColor: '#f7f6f3',
                            borderRadius: 3,
                            marginRight: 8,
                        }}>
                            <Text style={{ fontSize: 12, color: '#787774' }}>Add cover</Text>
                        </Pressable>
                        <Pressable style={{
                            paddingHorizontal: 10,
                            paddingVertical: 4,
                            backgroundColor: '#f7f6f3',
                            borderRadius: 3,
                        }}>
                            <Text style={{ fontSize: 12, color: '#787774' }}>Add comment</Text>
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'github',
            name: 'GitHub Style',
            description: 'Developer-focused with markdown hint',
            preview: (
                <View style={{ backgroundColor: '#f6f8fa' }}>
                    <View style={{ padding: 16 }}>
                        <View style={{
                            backgroundColor: '#fff',
                            borderRadius: 6,
                            borderWidth: 1,
                            borderColor: '#d1d5da',
                            padding: 8,
                        }}>
                            <View style={{
                                flexDirection: 'row',
                                marginBottom: 8,
                                paddingBottom: 8,
                                borderBottomWidth: 1,
                                borderBottomColor: '#e1e4e8',
                            }}>
                                <Pressable style={{ marginRight: 16 }}>
                                    <Icon name="text-b" size={16} color="#586069" />
                                </Pressable>
                                <Pressable style={{ marginRight: 16 }}>
                                    <Icon name="text-italic" size={16} color="#586069" />
                                </Pressable>
                                <Pressable style={{ marginRight: 16 }}>
                                    <Icon name="code" size={16} color="#586069" />
                                </Pressable>
                                <Pressable style={{ marginRight: 16 }}>
                                    <Icon name="link" size={16} color="#586069" />
                                </Pressable>
                                <Pressable style={{ marginRight: 16 }}>
                                    <Icon name="list-bullets" size={16} color="#586069" />
                                </Pressable>
                                <Pressable>
                                    <Icon name="list-numbers" size={16} color="#586069" />
                                </Pressable>
                            </View>
                            <TextInput
                                style={{ fontSize: 14, color: '#24292e', minHeight: 60 }}
                                placeholder="Leave a comment"
                                placeholderTextColor="#6a737d"
                                multiline
                                editable={false}
                            />
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingHorizontal: 20,
                        paddingBottom: 12,
                    }}>
                        <Text style={{ fontSize: 12, color: '#6a737d' }}>
                            Markdown is supported
                        </Text>
                        <View style={{ flexDirection: 'row' }}>
                            <Pressable style={{
                                paddingHorizontal: 12,
                                paddingVertical: 6,
                                backgroundColor: '#fafbfc',
                                borderRadius: 6,
                                borderWidth: 1,
                                borderColor: '#d1d5da',
                                marginRight: 8,
                            }}>
                                <Text style={{ fontSize: 14, color: '#24292e' }}>Cancel</Text>
                            </Pressable>
                            <Pressable style={{
                                paddingHorizontal: 12,
                                paddingVertical: 6,
                                backgroundColor: '#2ea44f',
                                borderRadius: 6,
                            }}>
                                <Text style={{ fontSize: 14, color: '#fff', fontWeight: '600' }}>Comment</Text>
                            </Pressable>
                        </View>
                    </View>
                </View>
            ),
        },
        {
            id: 'imessage',
            name: 'Apple Messages',
            description: 'iOS native messaging style',
            preview: (
                <View style={{ backgroundColor: '#fff' }}>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'flex-end',
                        padding: 8,
                    }}>
                        <Pressable style={{ 
                            width: 34,
                            height: 34,
                            borderRadius: 17,
                            backgroundColor: '#007AFF',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginRight: 8,
                        }}>
                            <Icon name="camera" size={20} color="#fff" />
                        </Pressable>
                        <View style={{
                            flex: 1,
                            backgroundColor: '#e5e5ea',
                            borderRadius: 18,
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            marginRight: 8,
                            minHeight: 34,
                        }}>
                            <TextInput
                                style={{ fontSize: 17, color: '#000' }}
                                placeholder="iMessage"
                                placeholderTextColor="#8e8e93"
                                editable={false}
                            />
                        </View>
                        <Pressable style={{ 
                            width: 34,
                            height: 34,
                            borderRadius: 17,
                            backgroundColor: '#007AFF',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}>
                            <Icon name="arrow-up" size={20} color="#fff" />
                        </Pressable>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 12,
                        paddingBottom: 8,
                    }}>
                        <Pressable style={{ padding: 6, marginRight: 4 }}>
                            <Icon name="squares-four" size={20} color="#8e8e93" />
                        </Pressable>
                        <Pressable style={{ padding: 6, marginRight: 4 }}>
                            <Icon name="images" size={20} color="#8e8e93" />
                        </Pressable>
                        <Pressable style={{ padding: 6, marginRight: 4 }}>
                            <Icon name="note" size={20} color="#8e8e93" />
                        </Pressable>
                        <Pressable style={{ padding: 6 }}>
                            <Icon name="music-notes" size={20} color="#8e8e93" />
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'material',
            name: 'Material Design',
            description: 'Google\'s design language',
            preview: (
                <View style={{ backgroundColor: '#fff' }}>
                    <View style={{ padding: 16 }}>
                        <View style={{
                            borderBottomWidth: 2,
                            borderBottomColor: '#1976d2',
                            paddingBottom: 8,
                        }}>
                            <Text style={{
                                fontSize: 12,
                                color: '#1976d2',
                                marginBottom: 4,
                            }}>
                                Message
                            </Text>
                            <View style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                            }}>
                                <TextInput
                                    style={{ flex: 1, fontSize: 16, color: '#000' }}
                                    placeholder="Type your message"
                                    placeholderTextColor="#999"
                                    editable={false}
                                />
                                <Pressable style={{ marginLeft: 8 }}>
                                    <Icon name="paper-plane-tilt" size={24} color="#1976d2" />
                                </Pressable>
                            </View>
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 20,
                        paddingBottom: 12,
                    }}>
                        <Pressable style={{
                            width: 40,
                            height: 40,
                            borderRadius: 20,
                            backgroundColor: '#f5f5f5',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginRight: 12,
                        }}>
                            <Icon name="paperclip" size={20} color="#757575" />
                        </Pressable>
                        <Pressable style={{
                            width: 40,
                            height: 40,
                            borderRadius: 20,
                            backgroundColor: '#f5f5f5',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginRight: 12,
                        }}>
                            <Icon name="image" size={20} color="#757575" />
                        </Pressable>
                        <Pressable style={{
                            width: 40,
                            height: 40,
                            borderRadius: 20,
                            backgroundColor: '#f5f5f5',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginRight: 12,
                        }}>
                            <Icon name="microphone" size={20} color="#757575" />
                        </Pressable>
                        <Pressable style={{
                            width: 40,
                            height: 40,
                            borderRadius: 20,
                            backgroundColor: '#f5f5f5',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}>
                            <Icon name="map-pin" size={20} color="#757575" />
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'brutalist',
            name: 'Brutalist Style',
            description: 'Bold borders and high contrast',
            preview: (
                <View style={{ backgroundColor: '#ffeb3b' }}>
                    <View style={{ padding: 16 }}>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            backgroundColor: '#fff',
                            borderWidth: 3,
                            borderColor: '#000',
                            paddingHorizontal: 16,
                            minHeight: 56,
                        }}>
                            <TextInput
                                style={{ 
                                    flex: 1, 
                                    fontSize: 18, 
                                    color: '#000',
                                    fontWeight: 'bold',
                                }}
                                placeholder="TYPE HERE!"
                                placeholderTextColor="#666"
                                editable={false}
                            />
                            <Pressable style={{
                                backgroundColor: '#000',
                                paddingHorizontal: 20,
                                paddingVertical: 10,
                                marginLeft: 8,
                            }}>
                                <Text style={{ 
                                    color: '#fff', 
                                    fontSize: 16, 
                                    fontWeight: 'bold' 
                                }}>
                                    SEND
                                </Text>
                            </Pressable>
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 20,
                        paddingBottom: 12,
                    }}>
                        <Pressable style={{
                            backgroundColor: '#000',
                            borderWidth: 2,
                            borderColor: '#000',
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            marginRight: 8,
                        }}>
                            <Text style={{ color: '#fff', fontWeight: 'bold' }}>BOLD</Text>
                        </Pressable>
                        <Pressable style={{
                            backgroundColor: '#fff',
                            borderWidth: 2,
                            borderColor: '#000',
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            marginRight: 8,
                        }}>
                            <Text style={{ color: '#000', fontWeight: 'bold' }}>ITALIC</Text>
                        </Pressable>
                        <Pressable style={{
                            backgroundColor: '#f44336',
                            borderWidth: 2,
                            borderColor: '#000',
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                        }}>
                            <Text style={{ color: '#fff', fontWeight: 'bold' }}>LINK</Text>
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'glassmorphism',
            name: 'Glassmorphism',
            description: 'Translucent with blur effects',
            preview: (
                <View style={{ backgroundColor: '#1a1a2e' }}>
                    <View style={{ padding: 16 }}>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            backgroundColor: 'rgba(255, 255, 255, 0.1)',
                            borderRadius: 16,
                            borderWidth: 1,
                            borderColor: 'rgba(255, 255, 255, 0.2)',
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                        }}>
                            <TextInput
                                style={{ 
                                    flex: 1, 
                                    fontSize: 16, 
                                    color: '#fff',
                                }}
                                placeholder="Type a message..."
                                placeholderTextColor="rgba(255, 255, 255, 0.5)"
                                editable={false}
                            />
                            <Pressable style={{
                                width: 40,
                                height: 40,
                                borderRadius: 20,
                                backgroundColor: 'rgba(255, 255, 255, 0.2)',
                                alignItems: 'center',
                                justifyContent: 'center',
                                marginLeft: 12,
                            }}>
                                <Icon name="paper-plane-tilt" size={20} color="#fff" />
                            </Pressable>
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 20,
                        paddingBottom: 12,
                    }}>
                        <Pressable style={{
                            width: 36,
                            height: 36,
                            borderRadius: 18,
                            backgroundColor: 'rgba(255, 255, 255, 0.1)',
                            borderWidth: 1,
                            borderColor: 'rgba(255, 255, 255, 0.2)',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginRight: 12,
                        }}>
                            <Icon name="paperclip" size={16} color="rgba(255, 255, 255, 0.8)" />
                        </Pressable>
                        <Pressable style={{
                            width: 36,
                            height: 36,
                            borderRadius: 18,
                            backgroundColor: 'rgba(255, 255, 255, 0.1)',
                            borderWidth: 1,
                            borderColor: 'rgba(255, 255, 255, 0.2)',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginRight: 12,
                        }}>
                            <Icon name="image" size={16} color="rgba(255, 255, 255, 0.8)" />
                        </Pressable>
                        <Pressable style={{
                            width: 36,
                            height: 36,
                            borderRadius: 18,
                            backgroundColor: 'rgba(255, 255, 255, 0.1)',
                            borderWidth: 1,
                            borderColor: 'rgba(255, 255, 255, 0.2)',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}>
                            <Icon name="sparkle" size={16} color="rgba(255, 255, 255, 0.8)" />
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'spotify',
            name: 'Spotify Style',
            description: 'Music-focused with playback controls',
            preview: (
                <View style={{ backgroundColor: '#121212' }}>
                    <View style={{ padding: 16 }}>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            backgroundColor: '#282828',
                            borderRadius: 24,
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                        }}>
                            <Icon name="magnifying-glass" size={20} color="#b3b3b3" />
                            <TextInput
                                style={{ 
                                    flex: 1, 
                                    fontSize: 16, 
                                    color: '#fff',
                                    marginLeft: 12,
                                }}
                                placeholder="Search for songs..."
                                placeholderTextColor="#535353"
                                editable={false}
                            />
                            <Pressable style={{ marginLeft: 12 }}>
                                <Icon name="microphone" size={20} color="#1db954" />
                            </Pressable>
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingHorizontal: 20,
                        paddingBottom: 12,
                    }}>
                        <Pressable style={{ padding: 12 }}>
                            <Icon name="shuffle" size={24} color="#b3b3b3" />
                        </Pressable>
                        <Pressable style={{ padding: 12 }}>
                            <Icon name="skip-back" size={24} color="#fff" />
                        </Pressable>
                        <Pressable style={{
                            width: 56,
                            height: 56,
                            borderRadius: 28,
                            backgroundColor: '#1db954',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginHorizontal: 16,
                        }}>
                            <Icon name="play" size={29} color="#000" style={{ marginLeft: 2 }} />
                        </Pressable>
                        <Pressable style={{ padding: 12 }}>
                            <Icon name="skip-forward" size={24} color="#fff" />
                        </Pressable>
                        <Pressable style={{ padding: 12 }}>
                            <Icon name="repeat" size={24} color="#1db954" />
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'figma',
            name: 'Figma Style',
            description: 'Design tool with collaborative features',
            preview: (
                <View style={{ backgroundColor: '#2c2c2c' }}>
                    <View style={{ padding: 16 }}>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            backgroundColor: '#383838',
                            borderRadius: 8,
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                        }}>
                            <TextInput
                                style={{ flex: 1, fontSize: 14, color: '#fff' }}
                                placeholder="Add a comment..."
                                placeholderTextColor="#a0a0a0"
                                editable={false}
                            />
                            <Pressable style={{
                                paddingHorizontal: 16,
                                paddingVertical: 6,
                                backgroundColor: '#0d99ff',
                                borderRadius: 6,
                                marginLeft: 8,
                            }}>
                                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>
                                    Post
                                </Text>
                            </Pressable>
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingHorizontal: 20,
                        paddingBottom: 12,
                    }}>
                        <View style={{ flexDirection: 'row' }}>
                            <Pressable style={{ 
                                width: 28, 
                                height: 28, 
                                borderRadius: 14, 
                                backgroundColor: '#ff7262',
                                marginRight: -8,
                                borderWidth: 2,
                                borderColor: '#2c2c2c',
                            }} />
                            <Pressable style={{ 
                                width: 28, 
                                height: 28, 
                                borderRadius: 14, 
                                backgroundColor: '#0d99ff',
                                marginRight: -8,
                                borderWidth: 2,
                                borderColor: '#2c2c2c',
                                zIndex: -1,
                            }} />
                            <Pressable style={{ 
                                width: 28, 
                                height: 28, 
                                borderRadius: 14, 
                                backgroundColor: '#1abcfe',
                                borderWidth: 2,
                                borderColor: '#2c2c2c',
                                zIndex: -2,
                            }} />
                            <Text style={{ 
                                color: '#a0a0a0', 
                                fontSize: 12, 
                                marginLeft: 12,
                                alignSelf: 'center',
                            }}>
                                3 people here
                            </Text>
                        </View>
                        <View style={{ flexDirection: 'row' }}>
                            <Pressable style={{ padding: 4 }}>
                                <Icon name="smiley" size={20} color="#a0a0a0" />
                            </Pressable>
                            <Pressable style={{ padding: 4, marginLeft: 8 }}>
                                <Icon name="at" size={20} color="#a0a0a0" />
                            </Pressable>
                        </View>
                    </View>
                </View>
            ),
        },
        {
            id: 'twitter',
            name: 'Twitter/X Style',
            description: 'Microblogging with character limit',
            preview: (
                <View style={{ backgroundColor: '#000' }}>
                    <View style={{ padding: 16 }}>
                        <View style={{
                            borderRadius: 16,
                            borderWidth: 1,
                            borderColor: '#333',
                            padding: 12,
                        }}>
                            <TextInput
                                style={{ 
                                    fontSize: 18, 
                                    color: '#fff',
                                    minHeight: 60,
                                }}
                                placeholder="What's happening?"
                                placeholderTextColor="#71767b"
                                multiline
                                editable={false}
                            />
                            <View style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                marginTop: 12,
                            }}>
                                <View style={{ flexDirection: 'row' }}>
                                    <Pressable style={{ marginRight: 16 }}>
                                        <Icon name="image" size={20} color="#1d9bf0" />
                                    </Pressable>
                                    <Pressable style={{ marginRight: 16 }}>
                                        <Icon name="gif" size={20} color="#1d9bf0" />
                                    </Pressable>
                                    <Pressable style={{ marginRight: 16 }}>
                                        <Icon name="chart-bar" size={20} color="#1d9bf0" />
                                    </Pressable>
                                    <Pressable>
                                        <Icon name="smiley" size={20} color="#1d9bf0" />
                                    </Pressable>
                                </View>
                                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                    <Text style={{ color: '#71767b', fontSize: 14, marginRight: 12 }}>
                                        0/280
                                    </Text>
                                    <Pressable style={{
                                        paddingHorizontal: 16,
                                        paddingVertical: 8,
                                        backgroundColor: '#1d9bf0',
                                        borderRadius: 18,
                                    }}>
                                        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
                                            Post
                                        </Text>
                                    </Pressable>
                                </View>
                            </View>
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 20,
                        paddingBottom: 12,
                    }}>
                        <Pressable style={{
                            paddingHorizontal: 12,
                            paddingVertical: 4,
                            borderRadius: 12,
                            borderWidth: 1,
                            borderColor: '#333',
                            marginRight: 8,
                        }}>
                            <Text style={{ fontSize: 12, color: '#1d9bf0' }}>Everyone</Text>
                        </Pressable>
                        <Pressable style={{
                            paddingHorizontal: 12,
                            paddingVertical: 4,
                            borderRadius: 12,
                            borderWidth: 1,
                            borderColor: '#333',
                            marginRight: 8,
                        }}>
                            <Text style={{ fontSize: 12, color: '#71767b' }}>Location</Text>
                        </Pressable>
                        <Pressable style={{
                            paddingHorizontal: 12,
                            paddingVertical: 4,
                            borderRadius: 12,
                            borderWidth: 1,
                            borderColor: '#333',
                        }}>
                            <Text style={{ fontSize: 12, color: '#71767b' }}>Schedule</Text>
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'arc',
            name: 'Arc Browser Style',
            description: 'Minimal with command palette',
            preview: (
                <View style={{ backgroundColor: '#f6f6f6' }}>
                    <View style={{ padding: 16 }}>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            backgroundColor: '#fff',
                            borderRadius: 12,
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                            ...Platform.select({
                                ios: {
                                    shadowColor: '#000',
                                    shadowOffset: { width: 0, height: 2 },
                                    shadowOpacity: 0.05,
                                    shadowRadius: 8,
                                },
                                android: {
                                    elevation: 2,
                                },
                            }),
                        }}>
                            <Icon name="magnifying-glass" size={16} color="#999" />
                            <TextInput
                                style={{ 
                                    flex: 1, 
                                    fontSize: 15, 
                                    color: '#000',
                                    marginLeft: 12,
                                }}
                                placeholder="Search or enter URL..."
                                placeholderTextColor="#999"
                                editable={false}
                            />
                            <Pressable style={{
                                paddingHorizontal: 8,
                                paddingVertical: 4,
                                backgroundColor: '#f0f0f0',
                                borderRadius: 6,
                            }}>
                                <Text style={{ fontSize: 12, color: '#666' }}>⌘K</Text>
                            </Pressable>
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingHorizontal: 20,
                        paddingBottom: 12,
                    }}>
                        <Pressable style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingHorizontal: 12,
                            paddingVertical: 6,
                            backgroundColor: '#e8e8e8',
                            borderRadius: 8,
                            marginRight: 8,
                        }}>
                            <View style={{
                                width: 8,
                                height: 8,
                                borderRadius: 4,
                                backgroundColor: '#ff5f57',
                                marginRight: 6,
                            }} />
                            <Text style={{ fontSize: 13, color: '#333' }}>Space 1</Text>
                        </Pressable>
                        <Pressable style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingHorizontal: 12,
                            paddingVertical: 6,
                            backgroundColor: '#e8e8e8',
                            borderRadius: 8,
                            marginRight: 8,
                        }}>
                            <View style={{
                                width: 8,
                                height: 8,
                                borderRadius: 4,
                                backgroundColor: '#ffbd2e',
                                marginRight: 6,
                            }} />
                            <Text style={{ fontSize: 13, color: '#333' }}>Space 2</Text>
                        </Pressable>
                        <Pressable style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingHorizontal: 12,
                            paddingVertical: 6,
                            backgroundColor: '#e8e8e8',
                            borderRadius: 8,
                        }}>
                            <View style={{
                                width: 8,
                                height: 8,
                                borderRadius: 4,
                                backgroundColor: '#28ca42',
                                marginRight: 6,
                            }} />
                            <Text style={{ fontSize: 13, color: '#333' }}>Space 3</Text>
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'claude',
            name: 'Claude Style',
            description: 'AI assistant with artifacts',
            preview: (
                <View style={{ backgroundColor: '#f9f7f4' }}>
                    <View style={{ padding: 16 }}>
                        <View style={{
                            backgroundColor: '#fff',
                            borderRadius: 16,
                            borderWidth: 1,
                            borderColor: '#e5e3df',
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                        }}>
                            <TextInput
                                style={{ 
                                    fontSize: 16, 
                                    color: '#000',
                                    minHeight: 40,
                                }}
                                placeholder="Ask Claude anything..."
                                placeholderTextColor="#999"
                                multiline
                                editable={false}
                            />
                            <View style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                marginTop: 8,
                            }}>
                                <View style={{ flexDirection: 'row' }}>
                                    <Pressable style={{ marginRight: 16 }}>
                                        <Icon name="paperclip" size={20} color="#666" />
                                    </Pressable>
                                    <Pressable>
                                        <Icon name="code" size={20} color="#666" />
                                    </Pressable>
                                </View>
                                <Pressable style={{
                                    backgroundColor: '#d97706',
                                    paddingHorizontal: 16,
                                    paddingVertical: 8,
                                    borderRadius: 20,
                                }}>
                                    <Icon name="arrow-up" size={16} color="#fff" />
                                </Pressable>
                            </View>
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 20,
                        paddingBottom: 12,
                    }}>
                        <Pressable style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingHorizontal: 12,
                            paddingVertical: 6,
                            backgroundColor: '#fff',
                            borderRadius: 20,
                            borderWidth: 1,
                            borderColor: '#e5e3df',
                            marginRight: 8,
                        }}>
                            <View style={{
                                width: 6,
                                height: 6,
                                borderRadius: 3,
                                backgroundColor: '#d97706',
                                marginRight: 6,
                            }} />
                            <Text style={{ fontSize: 13, color: '#666' }}>Claude 3.5</Text>
                        </Pressable>
                        <Pressable style={{
                            paddingHorizontal: 12,
                            paddingVertical: 6,
                            backgroundColor: '#f4f2ee',
                            borderRadius: 20,
                            marginRight: 8,
                        }}>
                            <Text style={{ fontSize: 13, color: '#666' }}>Artifacts</Text>
                        </Pressable>
                        <Pressable style={{
                            paddingHorizontal: 12,
                            paddingVertical: 6,
                            backgroundColor: '#f4f2ee',
                            borderRadius: 20,
                        }}>
                            <Text style={{ fontSize: 13, color: '#666' }}>Projects</Text>
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'reddit',
            name: 'Reddit Style',
            description: 'Community-focused with markdown',
            preview: (
                <View style={{ backgroundColor: '#1a1a1b' }}>
                    <View style={{ padding: 12 }}>
                        <View style={{
                            backgroundColor: '#272729',
                            borderRadius: 4,
                            borderWidth: 1,
                            borderColor: '#343536',
                            padding: 12,
                        }}>
                            <TextInput
                                style={{ 
                                    fontSize: 14, 
                                    color: '#d7dadc',
                                    minHeight: 80,
                                }}
                                placeholder="What are your thoughts?"
                                placeholderTextColor="#818384"
                                multiline
                                editable={false}
                            />
                        </View>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            marginTop: 8,
                            backgroundColor: '#1a1a1b',
                            borderRadius: 4,
                            paddingVertical: 4,
                        }}>
                            <Pressable style={{ padding: 8 }}>
                                <Icon name="text-b" size={16} color="#818384" />
                            </Pressable>
                            <Pressable style={{ padding: 8 }}>
                                <Icon name="text-italic" size={16} color="#818384" />
                            </Pressable>
                            <Pressable style={{ padding: 8 }}>
                                <Icon name="link" size={16} color="#818384" />
                            </Pressable>
                            <Pressable style={{ padding: 8 }}>
                                <Icon name="text-strikethrough" size={16} color="#818384" />
                            </Pressable>
                            <Pressable style={{ padding: 8 }}>
                                <Icon name="code" size={16} color="#818384" />
                            </Pressable>
                            <View style={{ flex: 1 }} />
                            <Pressable style={{
                                paddingHorizontal: 16,
                                paddingVertical: 6,
                                backgroundColor: '#ff4500',
                                borderRadius: 20,
                                marginRight: 8,
                            }}>
                                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>
                                    Reply
                                </Text>
                            </Pressable>
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 16,
                        paddingBottom: 8,
                    }}>
                        <Pressable style={{ marginRight: 16 }}>
                            <Icon name="arrow-up" size={20} color="#818384" />
                        </Pressable>
                        <Text style={{ color: '#818384', fontSize: 16, marginRight: 16 }}>0</Text>
                        <Pressable style={{ marginRight: 16 }}>
                            <Icon name="arrow-down" size={20} color="#818384" />
                        </Pressable>
                        <Pressable style={{ marginRight: 16 }}>
                            <Icon name="chat" size={16} color="#818384" />
                        </Pressable>
                        <Pressable style={{ marginRight: 16 }}>
                            <Icon name="share" size={16} color="#818384" />
                        </Pressable>
                        <Pressable>
                            <Icon name="bookmark" size={16} color="#818384" />
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'wechat',
            name: 'WeChat Style',
            description: 'Chinese super-app design',
            preview: (
                <View style={{ backgroundColor: '#ededed' }}>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'flex-end',
                        padding: 8,
                    }}>
                        <Pressable style={{
                            width: 40,
                            height: 40,
                            borderRadius: 20,
                            backgroundColor: '#fff',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginRight: 8,
                            borderWidth: 1,
                            borderColor: '#e0e0e0',
                        }}>
                            <Icon name="microphone" size={24} color="#333" />
                        </Pressable>
                        <View style={{
                            flex: 1,
                            backgroundColor: '#fff',
                            borderRadius: 4,
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            marginRight: 8,
                            borderWidth: 1,
                            borderColor: '#e0e0e0',
                        }}>
                            <TextInput
                                style={{ fontSize: 16, color: '#000' }}
                                placeholder="Type message"
                                placeholderTextColor="#999"
                                editable={false}
                            />
                        </View>
                        <Pressable style={{
                            width: 40,
                            height: 40,
                            borderRadius: 20,
                            backgroundColor: '#fff',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginRight: 8,
                            borderWidth: 1,
                            borderColor: '#e0e0e0',
                        }}>
                            <Icon name="smiley" size={24} color="#333" />
                        </Pressable>
                        <Pressable style={{
                            width: 40,
                            height: 40,
                            borderRadius: 20,
                            backgroundColor: '#fff',
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderWidth: 1,
                            borderColor: '#e0e0e0',
                        }}>
                            <Icon name="plus" size={24} color="#333" />
                        </Pressable>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-around',
                        paddingVertical: 12,
                        backgroundColor: '#fff',
                        borderTopWidth: 1,
                        borderTopColor: '#e0e0e0',
                    }}>
                        <Pressable style={{ alignItems: 'center' }}>
                            <Icon name="camera" size={24} color="#576b95" />
                            <Text style={{ fontSize: 11, color: '#576b95', marginTop: 2 }}>Album</Text>
                        </Pressable>
                        <Pressable style={{ alignItems: 'center' }}>
                            <Icon name="video-camera" size={24} color="#576b95" />
                            <Text style={{ fontSize: 11, color: '#576b95', marginTop: 2 }}>Sight</Text>
                        </Pressable>
                        <Pressable style={{ alignItems: 'center' }}>
                            <Icon name="phone" size={24} color="#576b95" />
                            <Text style={{ fontSize: 11, color: '#576b95', marginTop: 2 }}>Call</Text>
                        </Pressable>
                        <Pressable style={{ alignItems: 'center' }}>
                            <Icon name="map-pin" size={24} color="#576b95" />
                            <Text style={{ fontSize: 11, color: '#576b95', marginTop: 2 }}>Location</Text>
                        </Pressable>
                        <Pressable style={{ alignItems: 'center' }}>
                            <Icon name="currency-dollar" size={24} color="#576b95" />
                            <Text style={{ fontSize: 11, color: '#576b95', marginTop: 2 }}>Transfer</Text>
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'obsidian',
            name: 'Obsidian Style',
            description: 'Note-taking with linking',
            preview: (
                <View style={{ backgroundColor: '#202020' }}>
                    <View style={{ padding: 16 }}>
                        <View style={{
                            backgroundColor: '#262626',
                            borderRadius: 6,
                            borderWidth: 1,
                            borderColor: '#404040',
                            padding: 12,
                        }}>
                            <TextInput
                                style={{ 
                                    fontSize: 15, 
                                    color: '#e0e0e0',
                                    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
                                }}
                                placeholder="# Start typing..."
                                placeholderTextColor="#666"
                                editable={false}
                            />
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 20,
                        paddingBottom: 12,
                    }}>
                        <Pressable style={{ padding: 6, marginRight: 8 }}>
                            <Text style={{ color: '#7f6df2', fontSize: 16 }}>[[</Text>
                        </Pressable>
                        <Pressable style={{ padding: 6, marginRight: 8 }}>
                            <Icon name="tag" size={16} color="#7f6df2" />
                        </Pressable>
                        <Pressable style={{ padding: 6, marginRight: 8 }}>
                            <Icon name="text-b" size={16} color="#666" />
                        </Pressable>
                        <Pressable style={{ padding: 6, marginRight: 8 }}>
                            <Icon name="text-italic" size={16} color="#666" />
                        </Pressable>
                        <Pressable style={{ padding: 6, marginRight: 8 }}>
                            <Icon name="code" size={16} color="#666" />
                        </Pressable>
                        <View style={{ flex: 1 }} />
                        <Pressable style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingHorizontal: 10,
                            paddingVertical: 4,
                            backgroundColor: '#404040',
                            borderRadius: 4,
                        }}>
                            <Icon name="file-text" size={14} color="#e0e0e0" />
                            <Text style={{ color: '#e0e0e0', fontSize: 12, marginLeft: 4 }}>
                                Markdown
                            </Text>
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'snapchat',
            name: 'Snapchat Style',
            description: 'Ephemeral messaging with camera',
            preview: (
                <View style={{ backgroundColor: '#000' }}>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        padding: 12,
                    }}>
                        <Pressable style={{
                            width: 50,
                            height: 50,
                            borderRadius: 25,
                            backgroundColor: '#fffc00',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginRight: 12,
                        }}>
                            <Icon name="camera" size={29} color="#000" />
                        </Pressable>
                        <View style={{
                            flex: 1,
                            backgroundColor: '#1a1a1a',
                            borderRadius: 25,
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                            marginRight: 12,
                        }}>
                            <TextInput
                                style={{ fontSize: 16, color: '#fff' }}
                                placeholder="Send a chat"
                                placeholderTextColor="#666"
                                editable={false}
                            />
                        </View>
                        <Pressable style={{
                            width: 36,
                            height: 36,
                            borderRadius: 18,
                            backgroundColor: '#1a1a1a',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}>
                            <Icon name="dots-three" size={24} color="#fff" />
                        </Pressable>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingBottom: 12,
                    }}>
                        <Pressable style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            backgroundColor: '#fffc00',
                            borderRadius: 20,
                            marginRight: 8,
                        }}>
                            <Text style={{ color: '#000', fontSize: 14, fontWeight: '600' }}>
                                Snap
                            </Text>
                        </Pressable>
                        <Pressable style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            backgroundColor: '#1a1a1a',
                            borderRadius: 20,
                            marginRight: 8,
                        }}>
                            <Text style={{ color: '#fff', fontSize: 14 }}>
                                Stickers
                            </Text>
                        </Pressable>
                        <Pressable style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            backgroundColor: '#1a1a1a',
                            borderRadius: 20,
                        }}>
                            <Text style={{ color: '#fff', fontSize: 14 }}>
                                Games
                            </Text>
                        </Pressable>
                    </View>
                </View>
            ),
        },
        {
            id: 'teams',
            name: 'Microsoft Teams',
            description: 'Corporate communication style',
            preview: (
                <View style={{ backgroundColor: '#f5f5f5' }}>
                    <View style={{ padding: 12 }}>
                        <View style={{
                            backgroundColor: '#fff',
                            borderRadius: 4,
                            borderWidth: 1,
                            borderColor: '#e1e1e1',
                            paddingBottom: 8,
                        }}>
                            <View style={{
                                flexDirection: 'row',
                                borderBottomWidth: 1,
                                borderBottomColor: '#e1e1e1',
                                paddingHorizontal: 12,
                                paddingVertical: 8,
                            }}>
                                <Pressable style={{ marginRight: 16 }}>
                                    <Icon name="text-b" size={20} color="#605e5c" />
                                </Pressable>
                                <Pressable style={{ marginRight: 16 }}>
                                    <Icon name="text-italic" size={20} color="#605e5c" />
                                </Pressable>
                                <Pressable style={{ marginRight: 16 }}>
                                    <Icon name="text-underline" size={20} color="#605e5c" />
                                </Pressable>
                                <Pressable style={{ marginRight: 16 }}>
                                    <Icon name="text-aa" size={20} color="#605e5c" />
                                </Pressable>
                                <View style={{ flex: 1 }} />
                                <Pressable>
                                    <Icon name="dots-three" size={20} color="#605e5c" />
                                </Pressable>
                            </View>
                            <TextInput
                                style={{ 
                                    fontSize: 14, 
                                    color: '#201f1e',
                                    paddingHorizontal: 12,
                                    paddingVertical: 8,
                                    minHeight: 40,
                                }}
                                placeholder="Type a new message"
                                placeholderTextColor="#a19f9d"
                                editable={false}
                            />
                            <View style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                paddingHorizontal: 12,
                                marginTop: 8,
                            }}>
                                <View style={{ flexDirection: 'row' }}>
                                    <Pressable style={{ marginRight: 16 }}>
                                        <Icon name="paperclip" size={20} color="#605e5c" />
                                    </Pressable>
                                    <Pressable style={{ marginRight: 16 }}>
                                        <Icon name="smiley" size={20} color="#605e5c" />
                                    </Pressable>
                                    <Pressable>
                                        <Icon name="gif" size={20} color="#605e5c" />
                                    </Pressable>
                                </View>
                                <Pressable style={{
                                    backgroundColor: '#6264a7',
                                    paddingHorizontal: 20,
                                    paddingVertical: 8,
                                    borderRadius: 4,
                                }}>
                                    <Icon name="paper-plane-tilt" size={16} color="#fff" />
                                </Pressable>
                            </View>
                        </View>
                    </View>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 16,
                        paddingBottom: 8,
                    }}>
                        <Pressable style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingHorizontal: 12,
                            paddingVertical: 6,
                            backgroundColor: '#fff',
                            borderRadius: 16,
                            borderWidth: 1,
                            borderColor: '#e1e1e1',
                            marginRight: 8,
                        }}>
                            <Icon name="video-camera" size={16} color="#6264a7" />
                            <Text style={{ fontSize: 13, color: '#605e5c', marginLeft: 6 }}>
                                Meet now
                            </Text>
                        </Pressable>
                        <Pressable style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingHorizontal: 12,
                            paddingVertical: 6,
                            backgroundColor: '#fff',
                            borderRadius: 16,
                            borderWidth: 1,
                            borderColor: '#e1e1e1',
                        }}>
                            <Icon name="calendar" size={16} color="#6264a7" />
                            <Text style={{ fontSize: 13, color: '#605e5c', marginLeft: 6 }}>
                                Schedule
                            </Text>
                        </Pressable>
                    </View>
                </View>
            ),
        },
    ];

    // Render the selected style at the bottom
    const renderActiveInput = () => {
        const style = inputStyles.find(s => s.id === selectedStyle);
        if (!style) return null;
        
        return (
            <View style={{
                position: 'absolute',
                bottom: safeArea.bottom,
                left: 0,
                right: 0,
                backgroundColor: '#fff',
                borderTopWidth: 1,
                borderTopColor: '#e0e0e0',
                ...Platform.select({
                    ios: {
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: -2 },
                        shadowOpacity: 0.1,
                        shadowRadius: 4,
                    },
                    android: {
                        elevation: 8,
                    },
                }),
            }}>
                <View style={{ paddingBottom: 8, paddingTop: 8 }}>
                    <Text style={{
                        textAlign: 'center',
                        fontSize: 12,
                        color: '#666',
                        marginBottom: 4,
                        ...Typography.default(),
                    }}>
                        Active Style: {style.name}
                    </Text>
                    {style.preview}
                </View>
            </View>
        );
    };

    return (
        <View style={{ flex: 1, backgroundColor: '#f5f5f5' }}>
            <ScrollView 
                style={{ flex: 1 }}
                contentContainerStyle={{ 
                    paddingBottom: 250 + safeArea.bottom,
                    paddingTop: 16,
                }}
            >
                <Text style={{
                    fontSize: 24,
                    fontWeight: 'bold',
                    marginBottom: 8,
                    paddingHorizontal: 16,
                    ...Typography.default('semiBold'),
                }}>
                    Input Style Variants
                </Text>
                <Text style={{
                    fontSize: 14,
                    color: '#666',
                    marginBottom: 24,
                    paddingHorizontal: 16,
                    ...Typography.default(),
                }}>
                    Tap any style to see it applied to the bottom input
                </Text>

                {inputStyles.map((style) => (
                    <Pressable
                        key={style.id}
                        onPress={() => setSelectedStyle(style.id)}
                        style={{
                            marginHorizontal: 16,
                            marginBottom: 16,
                            backgroundColor: '#fff',
                            borderRadius: 12,
                            overflow: 'hidden',
                            borderWidth: selectedStyle === style.id ? 2 : 1,
                            borderColor: selectedStyle === style.id ? '#007AFF' : '#e0e0e0',
                        }}
                    >
                        <View style={{
                            paddingHorizontal: 16,
                            paddingTop: 12,
                            paddingBottom: 8,
                        }}>
                            <View style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                marginBottom: 4,
                            }}>
                                <Text style={{
                                    fontSize: 18,
                                    fontWeight: '600',
                                    color: '#000',
                                    ...Typography.default('semiBold'),
                                }}>
                                    {style.name}
                                </Text>
                                {selectedStyle === style.id && (
                                    <Icon name="check-circle" size={24} color="#007AFF" />
                                )}
                            </View>
                            <Text style={{
                                fontSize: 14,
                                color: '#666',
                                marginBottom: 12,
                                ...Typography.default(),
                            }}>
                                {style.description}
                            </Text>
                        </View>
                        <View style={{
                            borderTopWidth: 1,
                            borderTopColor: '#f0f0f0',
                        }}>
                            {style.preview}
                        </View>
                    </Pressable>
                ))}
            </ScrollView>
            
            {renderActiveInput()}
        </View>
    );
}